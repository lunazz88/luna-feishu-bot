const fs = require('fs');
const path = require('path');
const { config, configFromEnvFile } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { valueToNumber, valueToText } = require('./matcher');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function safeName(name) {
  return String(name || 'final-data')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
}

function tableUrlFromAppToken(baseUrl, appToken, tableId) {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/base/${appToken}?table=${tableId}`;
}

function parseTableId(url) {
  try {
    return new URL(url).searchParams.get('table') || '';
  } catch {
    return '';
  }
}

function chineseNumber(n) {
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 10) return n === 10 ? '十' : digits[n];
  if (n < 20) return `十${digits[n - 10]}`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${digits[tens]}十${digits[ones]}`;
}

function chineseDateName(dateText) {
  const [, month, day] = String(dateText).match(/^20\d{2}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) throw new Error(`无法识别日期：${dateText}`);
  return `${chineseNumber(Number(month))}月${chineseNumber(Number(day))}号`;
}

function parseChineseNumber(text) {
  const map = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const value = String(text || '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    const tens = left ? map[left] || 0 : 1;
    const ones = right ? map[right] || 0 : 0;
    return tens * 10 + ones;
  }
  return map[value] || null;
}

function parseBusinessDate(text, now = new Date()) {
  const value = String(text || '').replace(/@_user_\d+\s*/g, '').trim();
  const full = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;

  const short = value.match(/(?:更新)?\s*(\d{1,2})\s*[./-]\s*(\d{1,2})\s*(?:的)?\s*(?:数据)?/);
  if (short) return `${now.getFullYear()}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;

  const numeric = value.match(/(?:更新)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*(?:的)?\s*(?:数据)?/);
  if (numeric) return `${now.getFullYear()}-${numeric[1].padStart(2, '0')}-${numeric[2].padStart(2, '0')}`;

  const chinese = value.match(/(?:更新)?\s*([一二两三四五六七八九十]{1,3})\s*月\s*([一二两三四五六七八九十]{1,3})\s*(?:日|号)?\s*(?:的)?\s*(?:数据)?/);
  if (chinese) {
    const month = parseChineseNumber(chinese[1]);
    const day = parseChineseNumber(chinese[2]);
    if (month && day) return `${now.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  return '';
}

function isFinalUpdateCommand(text) {
  const value = String(text || '').replace(/@_user_\d+\s*/g, '').trim();
  return Boolean(parseBusinessDate(value)) && /^更新/.test(value);
}

function collectSummaryFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSummaryFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === '处理结果摘要.json') out.push(fullPath);
  }
  return out;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findLatestProcessingSummary(businessDate, outputsRoot = path.join(process.cwd(), 'outputs')) {
  const candidates = collectSummaryFiles(outputsRoot)
    .map((file) => {
      const data = readJsonSafe(file);
      if (!data || data.businessDate !== businessDate || !data.targetUrl) return null;
      const stat = fs.statSync(file);
      return { file, data, time: Date.parse(data.createdAt || '') || stat.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.time - a.time);
  return candidates[0] || null;
}

function normalizeName(value) {
  return valueToText(value).replace(/\s+/g, '').toLowerCase();
}

function tableMatches(table, dateName, keywords = []) {
  const name = normalizeName(table.name);
  if (!name.includes(normalizeName(dateName))) return false;
  return !keywords.length || keywords.some((keyword) => name.includes(normalizeName(keyword)));
}

async function readDateTableFromBase(feishu, baseUrl, dateName, keywords = []) {
  const appToken = await feishu.resolveBitableAppToken(baseUrl);
  const tables = await feishu.listTables(appToken);
  const table = tables.find((item) => tableMatches(item, dateName, keywords))
    || tables.find((item) => tableMatches(item, dateName));
  if (!table) {
    throw new Error(`没有在多维表格中找到 ${dateName} 的表页：${baseUrl}`);
  }
  return feishu.readBitableTable(appToken, table.table_id);
}

async function readBitableByUrl(feishu, url) {
  const appToken = await feishu.resolveBitableAppToken(url);
  const tableId = parseTableId(url);
  if (tableId) return feishu.readBitableTable(appToken, tableId);
  const tables = await feishu.listTables(appToken);
  const table = tables[0];
  if (!table) throw new Error(`多维表格没有数据表：${url}`);
  return feishu.readBitableTable(appToken, table.table_id);
}

async function readDateTableWithFallback(feishu, baseUrl, dateName, keywords, fallbackUrl) {
  try {
    return await readDateTableFromBase(feishu, baseUrl, dateName, keywords);
  } catch (error) {
    if (!fallbackUrl) throw error;
    return readBitableByUrl(feishu, fallbackUrl);
  }
}

function isFormulaField(field) {
  return field.type === 20 || field.ui_type === 'Formula';
}

function cloneField(field) {
  const out = {
    field_name: field.field_name,
    type: field.type,
    ui_type: field.ui_type,
  };
  if (field.property) out.property = JSON.parse(JSON.stringify(field.property));
  if (field.description) out.description = field.description;
  return out;
}

function replaceFormulaReferences(formula, oldTableId, newTableId, fieldIdMap) {
  let out = String(formula || '').replaceAll(`$table[${oldTableId}]`, `$table[${newTableId}]`);
  for (const [oldFieldId, newFieldId] of fieldIdMap.entries()) {
    out = out.replaceAll(`$field[${oldFieldId}]`, `$field[${newFieldId}]`);
  }
  return out;
}

function uniqueTableName(tables, wantedName) {
  if (!tables.some((table) => table.name === wantedName)) return wantedName;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  return `${wantedName}_${stamp}`;
}

async function createTableLikeSource(feishu, targetAppToken, source, wantedName) {
  const tables = await feishu.listTables(targetAppToken);
  const tableName = uniqueTableName(tables, wantedName);
  const normalFields = source.fields.filter((field) => !isFormulaField(field));
  const formulaFields = source.fields.filter(isFormulaField);
  const primaryField = normalFields.find((field) => field.is_primary) || normalFields[0];
  const restNormalFields = normalFields.filter((field) => field !== primaryField);
  const fieldIdMap = new Map();

  const defaultViewName = config.resultViewNames[0] || '所有项目';
  const created = await feishu.createTable(targetAppToken, tableName, [cloneField(primaryField)], { defaultViewName });
  const defaultFields = await feishu.listFields(targetAppToken, created.table_id);
  const createdPrimary = defaultFields.find((field) => field.is_primary) || defaultFields[0];
  const updatedPrimary = await feishu.updateField(targetAppToken, created.table_id, createdPrimary.field_id, cloneField(primaryField));
  fieldIdMap.set(primaryField.field_id, updatedPrimary.field_id || createdPrimary.field_id);

  for (const field of restNormalFields) {
    const createdField = await feishu.createField(targetAppToken, created.table_id, cloneField(field));
    fieldIdMap.set(field.field_id, createdField.field_id);
  }

  for (const field of formulaFields) {
    const copied = cloneField(field);
    copied.property = copied.property || {};
    copied.property.formula_expression = replaceFormulaReferences(
      copied.property.formula_expression,
      source.table.table_id,
      created.table_id,
      fieldIdMap
    );
    const createdField = await feishu.createField(targetAppToken, created.table_id, copied);
    fieldIdMap.set(field.field_id, createdField.field_id);
  }

  await feishu.ensureClassifiedGridViews(targetAppToken, created.table_id, config.resultViewNames);
  await feishu.grantResultChatEdit(targetAppToken);
  return feishu.readBitableTable(targetAppToken, created.table_id);
}

function valueForTargetField(field, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (isFormulaField(field)) return undefined;
  if (field.type === 2 || field.ui_type === 'Number' || field.ui_type === 'Currency') return valueToNumber(value);
  if (field.type === 5 || field.ui_type === 'DateTime') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(valueToText(value));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (field.type === 11 || field.ui_type === 'User') {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((item) => item && typeof item === 'object')) return undefined;
    return value;
  }
  if (field.type === 17 || field.ui_type === 'Attachment') return Array.isArray(value) ? value : undefined;
  return value;
}

function buildCreateRecord(sourceRecord, targetFieldsByName) {
  const fields = {};
  for (const [fieldName, value] of Object.entries(sourceRecord.fields || {})) {
    const field = targetFieldsByName.get(fieldName);
    if (!field) continue;
    const converted = valueForTargetField(field, value);
    if (converted === undefined || converted === null || converted === '') continue;
    fields[fieldName] = converted;
  }
  return Object.keys(fields).length ? { fields } : null;
}

async function appendRecordsFromSource(feishu, source, target, label) {
  const targetFieldsByName = new Map(target.fields.map((field) => [field.field_name, field]));
  const records = source.rawRecords
    .map((record) => buildCreateRecord(record, targetFieldsByName))
    .filter(Boolean);
  await feishu.batchCreateRecords(target.appToken, target.table.table_id, records);
  return {
    label,
    sourceTableName: source.table.name,
    rows: source.rawRecords.length,
    appended: records.length,
  };
}

async function finalizeDailyCorrection(options = {}) {
  const businessDate = options.businessDate || parseBusinessDate(options.commandText || '');
  if (!businessDate) throw new Error('没有识别到日期，请发送类似：更新六月八号数据');

  const dateName = chineseDateName(businessDate);
  const summaryHit = options.summary || findLatestProcessingSummary(businessDate, options.outputsRoot);
  const sourceSummary = summaryHit ? (summaryHit.data || summaryHit) : {};
  const docConfig = options.docConfig
    || (process.env.FEISHU_DOC_ENV_PATH ? configFromEnvFile(process.env.FEISHU_DOC_ENV_PATH) : config);
  const feishu = options.feishu || await new FeishuClient(docConfig).init();

  const aiSource = await readDateTableWithFallback(
    feishu,
    options.aiUnconfirmedBaseUrl || config.aiCorrectionBaseUrl,
    dateName,
    ['ai修正', '修正'],
    sourceSummary.targetUrl
  );
  const crawlSource = await readDateTableWithFallback(
    feishu,
    options.crawlFailureBaseUrl || config.crawlFailureBaseUrl,
    dateName,
    ['抓取失败'],
    sourceSummary.crawlFailureTable && sourceSummary.crawlFailureTable.url
  );
  const mismatchSource = await readDateTableWithFallback(
    feishu,
    options.shooterMismatchBaseUrl || config.shooterMismatchBaseUrl,
    dateName,
    ['投手不一致'],
    sourceSummary.mismatchTable && sourceSummary.mismatchTable.url
  );
  const unmatchedSource = await readDateTableWithFallback(
    feishu,
    options.unmatchedBaseUrl || config.unmatchedBaseUrl,
    dateName,
    ['未匹配'],
    sourceSummary.unmatchedTable && sourceSummary.unmatchedTable.url
  );

  const confirmedBaseUrl = options.aiConfirmedBaseUrl || config.aiConfirmedBaseUrl;
  const confirmedAppToken = await feishu.resolveBitableAppToken(confirmedBaseUrl);
  const finalName = options.finalName || `${dateName}最终修正表`;
  const target = await createTableLikeSource(feishu, confirmedAppToken, aiSource, finalName);

  const appended = [];
  appended.push(await appendRecordsFromSource(feishu, aiSource, target, 'AI修正'));
  appended.push(await appendRecordsFromSource(feishu, crawlSource, target, '抓取失败'));
  appended.push(await appendRecordsFromSource(feishu, mismatchSource, target, '投手不一致'));
  appended.push(await appendRecordsFromSource(feishu, unmatchedSource, target, '未匹配'));

  const finalTarget = await feishu.readBitableTable(target.appToken, target.table.table_id);
  const finalUrl = tableUrlFromAppToken(confirmedBaseUrl, target.appToken, target.table.table_id);
  const result = {
    businessDate,
    dateName,
    finalName: target.table.name,
    mode: 'write_into_ai_confirmed_base',
    sourceSummaryPath: summaryHit ? summaryHit.file : '',
    aiUnconfirmedBaseUrl: options.aiUnconfirmedBaseUrl || config.aiCorrectionBaseUrl,
    aiConfirmedBaseUrl: confirmedBaseUrl,
    finalUrl,
    finalAppToken: target.appToken,
    finalTableId: target.table.table_id,
    appended,
    aiRows: appended.find((item) => item.label === 'AI修正').appended,
    appendedRows: appended.reduce((sum, item) => sum + (item.appended || 0), 0),
    finalRows: finalTarget.rawRecords.length,
    createdAt: new Date().toISOString(),
  };

  const outputDir = path.join(process.cwd(), 'outputs', `${safeName(result.finalName)}`);
  const summaryPath = path.join(outputDir, '处理结果摘要.json');
  writeJson(summaryPath, result);
  result.summaryPath = summaryPath;
  return result;
}

function formatFinalSummary(result) {
  const count = (label) => {
    const item = result.appended.find((entry) => entry.label === label);
    return item ? item.appended : 0;
  };

  return [
    `处理完成：${result.finalName}`,
    `人工确认表链接：${result.finalUrl}`,
    '',
    `AI修正写入：${count('AI修正')} 条`,
    `抓取失败写入：${count('抓取失败')} 条`,
    `投手不一致写入：${count('投手不一致')} 条`,
    `未匹配写入：${count('未匹配')} 条`,
    `最终表合计：${result.finalRows} 条`,
  ].join('\n');
}

async function main() {
  const arg = process.argv.slice(2).join(' ');
  const date = parseBusinessDate(arg) || arg;
  const result = await finalizeDailyCorrection({ businessDate: date });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const details = error.details || { message: error.message };
    console.error(JSON.stringify(details, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  finalizeDailyCorrection,
  findLatestProcessingSummary,
  formatFinalSummary,
  isFinalUpdateCommand,
  parseBusinessDate,
};
