const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { normalizeCommon, valueToNumber, valueToText } = require('./matcher');
const {
  buildTargetRecord,
  chineseDateName,
  createCorrectionTable,
  normalFields,
  tableUrlFromAppToken,
} = require('./processIncomingRawFile');

const Lark = require(path.join(config.nodeModulesDir, '@larksuiteoapi/node-sdk'));

const cacheRoot = path.join(process.cwd(), 'outputs', 'viklik-xmp');
const fileRegistryPath = path.join(cacheRoot, 'xmp-file-registry.json');
const processedMessageIds = new Set();

const FIELD = {
  date: ['日期'],
  project: ['项目', '项目名称'],
  code: ['Code', 'code', 'CODE'],
  shooter: ['投手'],
  country: ['国家'],
  kpi: ['KPI(美金）', 'KPI'],
  spend: ['花费', '花费金额'],
  impressions: ['展示数', '展示次数'],
  clicks: ['点击数', '点击量'],
  registrations: ['注册数', '注册人数'],
  firstDeposits: ['首存数', '首存人数'],
  crawlStatus: ['抓取状态', '抓取\n状态'],
};

const METRIC_FIELDS = {
  spend: '花费金额',
  impressions: '展示次数',
  clicks: '点击量',
  registrations: '注册人数',
  firstDeposits: '首存人数',
};

const REVIEW_FIELDS = [
  '处理状态',
  '问题类型',
  '处理建议',
  '原因',
  'XMP行号',
  'XMP项目',
  'XMP code',
  'XMP投手',
  'XMP国家',
  'XMP花费',
  'XMP展示次数',
  'XMP点击量',
  'XMP注册人数',
  'XMP首存人数',
  '晨报行号',
  '晨报项目',
  '晨报 code',
  '晨报投手',
  '晨报国家',
  '候选数量',
  '候选摘要',
  '匹配策略',
];

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function logStep(entry) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2));
}

function safeName(name) {
  return String(name || 'file')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
}

function parseMessageText(message) {
  const content = parseJson(message.content);
  return valueToText(content.text || '');
}

function summarizeMessage(message) {
  const content = parseJson(message.content);
  return {
    messageId: message.message_id,
    chatId: message.chat_id,
    messageType: message.message_type,
    createTime: message.create_time,
    fileKey: content.file_key || content.fileKey || content.key || '',
    fileName: content.file_name || content.fileName || content.name || '',
    content,
  };
}

function standardXmpDate(fileName) {
  const match = String(fileName || '').match(/^crawler广告数据报告_(20\d{2}-\d{2}-\d{2})\.xlsx$/i);
  return match ? match[1] : '';
}

function parseCommandDate(text, now = new Date()) {
  const raw = String(text || '');
  const full = raw.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;

  const short = raw.match(/(?:^|[^\d])(\d{1,2})[./月-](\d{1,2})(?:[^\d]|$)/);
  if (!short) return '';
  return `${now.getFullYear()}-${short[1].padStart(2, '0')}-${short[2].padStart(2, '0')}`;
}

function shouldTreatAsCommand(message, text) {
  if (config.xmpOperatorChatId && message.chat_id !== config.xmpOperatorChatId) return false;
  if (!parseCommandDate(text)) return false;
  if (config.xmpOperatorChatId) return true;
  return /@|xmp|XMP|匹配|晨报/.test(text);
}

function loadRegistry() {
  if (!fs.existsSync(fileRegistryPath)) return { filesByDate: {} };
  return JSON.parse(fs.readFileSync(fileRegistryPath, 'utf8'));
}

function saveRegistry(registry) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(fileRegistryPath, JSON.stringify(registry, null, 2));
}

function rememberFile(entry) {
  const registry = loadRegistry();
  registry.filesByDate[entry.businessDate] = [
    entry,
    ...(registry.filesByDate[entry.businessDate] || []).filter((item) => item.messageId !== entry.messageId),
  ].slice(0, 10);
  saveRegistry(registry);
}

function latestFileForDate(businessDate) {
  const registry = loadRegistry();
  const entries = registry.filesByDate[businessDate] || [];
  return entries.find((entry) => entry.outputPath && fs.existsSync(entry.outputPath)) || null;
}

function getCell(row, headers, names) {
  const normalized = headers.map((header) => valueToText(header).replace(/\s+/g, '').toLowerCase());
  for (const name of names) {
    const key = name.replace(/\s+/g, '').toLowerCase();
    const index = normalized.indexOf(key);
    if (index >= 0) return row[index];
  }
  return '';
}

function normalizeAdsRow(row, headers, index) {
  return normalizeCommon({
    sourceRow: index + 2,
    date: valueToText(getCell(row, headers, FIELD.date)),
    project: valueToText(getCell(row, headers, FIELD.project)),
    code: valueToText(getCell(row, headers, FIELD.code)),
    shooter: valueToText(getCell(row, headers, FIELD.shooter)),
    country: valueToText(getCell(row, headers, FIELD.country)),
    kpi: getCell(row, headers, FIELD.kpi),
    crawlStatus: valueToText(getCell(row, headers, FIELD.crawlStatus)),
    metrics: {
      spend: valueToNumber(getCell(row, headers, FIELD.spend)),
      impressions: valueToNumber(getCell(row, headers, FIELD.impressions)),
      clicks: valueToNumber(getCell(row, headers, FIELD.clicks)),
      registrations: valueToNumber(getCell(row, headers, FIELD.registrations)),
      firstDeposits: valueToNumber(getCell(row, headers, FIELD.firstDeposits)),
    },
  });
}

function readAdsRows(feishu, filePath) {
  const rows = feishu.readAdsRowsFromXlsx(filePath);
  return rows.map((row) => normalizeCommon(row));
}

function matchKey(row) {
  return [row.projectNorm, row.codeStrong, row.shooterNorm, row.countryNorm].join('\u0001');
}

function projectCodeCountryKey(row) {
  return [row.projectNorm, row.codeStrong, row.countryNorm].join('\u0001');
}

function hasUsableKey(key) {
  return Boolean(String(key || '').replace(/\u0001/g, ''));
}

function isCrawlFailure(ad) {
  const text = [
    ad.project,
    ad.code,
    ad.shooter,
    ad.country,
    ad.crawlStatus,
  ].map(valueToText).join(' ');
  return /无数据|抓取失败|失败/.test(text);
}

function indexRecords(records, keyFn) {
  const recordIndex = new Map();
  for (const record of records) {
    const key = keyFn(record);
    if (!hasUsableKey(key)) continue;
    if (!recordIndex.has(key)) recordIndex.set(key, []);
    recordIndex.get(key).push(record);
  }
  return recordIndex;
}

function matchAdsToRecords(adsRows, records) {
  const exactIndex = indexRecords(records, matchKey);
  const projectCodeCountryIndex = indexRecords(records, projectCodeCountryKey);
  const matches = [];
  const unmatched = [];
  const crawlFailures = [];
  const shooterMismatches = [];
  const duplicateRecords = [];

  for (const ad of adsRows) {
    const key = matchKey(ad);
    const projectCodeCountry = projectCodeCountryKey(ad);
    const candidates = exactIndex.get(key) || [];
    const projectCodeCountryCandidates = projectCodeCountryIndex.get(projectCodeCountry) || [];

    if (isCrawlFailure(ad)) {
      crawlFailures.push({
        ad,
        candidates: projectCodeCountryCandidates,
        reason: 'XMP原始数据标记为无数据/抓取失败，需先确认抓取状态',
      });
      continue;
    }

    if (candidates.length === 1) {
      matches.push({ ad, record: candidates[0], strategy: 'project+code+shooter+country' });
    } else if (candidates.length > 1) {
      duplicateRecords.push({
        ad,
        candidates,
        reason: '晨报/投手表存在多条相同 项目+code+投手+国家，无法自动判断唯一记录',
      });
    } else if (projectCodeCountryCandidates.length) {
      shooterMismatches.push({
        ad,
        candidates: projectCodeCountryCandidates,
        reason: '项目+code+国家一致，但投手不一致',
      });
    } else {
      unmatched.push({
        ad,
        candidates: [],
        reason: 'XMP有该行，但晨报/投手表中找不到相同 项目+code+国家',
      });
    }
  }

  return { matches, unmatched, crawlFailures, shooterMismatches, duplicateRecords };
}

function dateLabel(dateText) {
  const [, month, day] = String(dateText).match(/^20\d{2}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) return dateText;
  return `${Number(month)}.${Number(day)}`;
}

function paddedDateLabel(dateText) {
  const [, month, day] = String(dateText).match(/^20\d{2}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) return dateText;
  return `${month}.${day}`;
}

function tableIdFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).searchParams.get('table') || '';
  } catch {
    return '';
  }
}

function targetMatchTableName(businessDate) {
  return `${paddedDateLabel(businessDate)}-ai匹配表`;
}

function remapFieldIds(value, fieldIdMap) {
  if (Array.isArray(value)) return value.map((item) => remapFieldIds(item, fieldIdMap));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' && fieldIdMap[value] ? fieldIdMap[value] : value;
  }

  const output = {};
  for (const [key, nested] of Object.entries(value)) {
    output[key] = remapFieldIds(nested, fieldIdMap);
  }
  return output;
}

function viewPropertyForPatch(sourceProperty, fieldIdMap) {
  if (!sourceProperty) return null;
  const property = remapFieldIds(JSON.parse(JSON.stringify(sourceProperty)), fieldIdMap);
  if (property.hierarchy_config && !property.hierarchy_config.field_id) {
    delete property.hierarchy_config;
  }
  if ('filter_info' in property && !property.filter_info) delete property.filter_info;
  return Object.keys(property).length ? property : null;
}

async function sourceViewsWithProperty(feishu, appToken, tableId) {
  const views = await feishu.listViews(appToken, tableId);
  const detailed = [];
  for (const view of views) {
    detailed.push(await feishu.getView(appToken, tableId, view.view_id));
  }
  return detailed;
}

async function replicateSourceViews(feishu, appToken, targetTableId, sourceViews, fieldIdMap) {
  const existing = await feishu.listViews(appToken, targetTableId);
  const byName = new Map(existing.map((view) => [view.view_name, view]));
  const created = [];
  const patched = [];
  const skipped = [];

  for (const sourceView of sourceViews) {
    let targetView = byName.get(sourceView.view_name);
    if (!targetView) {
      targetView = await feishu.createView(appToken, targetTableId, sourceView.view_name, sourceView.view_type || 'grid');
      byName.set(targetView.view_name, targetView);
      created.push(sourceView.view_name);
    }

    const property = viewPropertyForPatch(sourceView.property, fieldIdMap);
    if (!property) continue;

    try {
      await feishu.patchView(appToken, targetTableId, targetView.view_id, { property });
      patched.push(sourceView.view_name);
    } catch (error) {
      skipped.push({
        viewName: sourceView.view_name,
        reason: error.details ? error.details.msg || error.details.message : error.message,
      });
    }
  }

  return { created, patched, skipped };
}

async function findTargetMatchTable(feishu, appToken, businessDate) {
  const tables = await feishu.listTables(appToken);
  const targetName = targetMatchTableName(businessDate);
  return tables.find((table) => table.name === targetName) || null;
}

async function createTargetMatchTable(feishu, appToken, source, businessDate) {
  const sourceViews = await sourceViewsWithProperty(feishu, appToken, source.table.table_id);
  const targetName = targetMatchTableName(businessDate);
  const target = await createCorrectionTable(
    feishu,
    appToken,
    source,
    targetName,
    { viewNames: sourceViews.map((view) => view.view_name).filter(Boolean) }
  );
  const viewReplica = await replicateSourceViews(
    feishu,
    appToken,
    target.table_id,
    sourceViews,
    target.fieldIdMap || {}
  );

  return {
    table_id: target.table_id,
    name: targetName,
    created: true,
    viewReplica,
  };
}

async function ensureResultTable(feishu, appToken, tableName) {
  const tables = await feishu.listTables(appToken);
  let table = tables.find((item) => item.name === tableName);
  if (!table) {
    table = await feishu.createTable(
      appToken,
      tableName,
      [{ field_name: REVIEW_FIELDS[0], type: 1, ui_type: 'Text' }],
      { defaultViewName: '表格' }
    );
    table.name = tableName;
  }

  const fields = await feishu.listFields(appToken, table.table_id);
  const existingNames = new Set(fields.map((field) => field.field_name));
  for (const fieldName of REVIEW_FIELDS.slice(1)) {
    if (existingNames.has(fieldName)) continue;
    await feishu.createField(appToken, table.table_id, {
      field_name: fieldName,
      type: 1,
      ui_type: 'Text',
    });
    existingNames.add(fieldName);
  }
  return table;
}

async function writeResultTable(feishu, appToken, tableName, rows) {
  const table = await ensureResultTable(feishu, appToken, tableName);
  const deletedRows = await clearTableRecords(feishu, appToken, table.table_id);
  await feishu.batchCreateRecords(appToken, table.table_id, rows);
  return {
    tableName,
    tableId: table.table_id,
    rows: rows.length,
    deletedRows,
  };
}

async function findShooterSource(feishu, appToken, baseUrl, businessDate) {
  const dateName = chineseDateName(businessDate);
  const shortDate = dateLabel(businessDate);
  const paddedDate = paddedDateLabel(businessDate);
  const tables = await feishu.listTables(appToken);
  const exactNames = [
    `${dateName}投手数据`,
    `${dateName}投手数据数据`,
    shortDate,
    paddedDate,
    `${shortDate}投手数据`,
    `${paddedDate}投手数据`,
  ];
  let table = tables.find((item) => exactNames.includes(item.name));
  if (!table) {
    table = tables.find((item) => {
      const name = item.name || '';
      const dateHit = name.includes(dateName) || name.includes(shortDate) || name.includes(paddedDate);
      return dateHit && !/-O$/i.test(name);
    });
  }
  if (!table) table = tables.find((item) => item.name.includes(dateName) && item.name.includes('投手'));

  const linkedTableId = tableIdFromUrl(baseUrl);
  if (!table && linkedTableId) table = tables.find((item) => item.table_id === linkedTableId);
  if (!table) throw new Error(`未找到 ${dateName} 对应的投手数据表`);

  return feishu.readBitableTable(appToken, table.table_id);
}

async function clearTableRecords(feishu, appToken, tableId) {
  const records = await feishu.listRecords(appToken, tableId);
  await feishu.batchDeleteRecords(appToken, tableId, records.map((record) => record.record_id).filter(Boolean));
  return records.length;
}

function metricText(metrics, key) {
  const value = metrics && metrics[key];
  return value === undefined || value === null ? '' : String(value);
}

function candidateSummary(candidates) {
  return (candidates || [])
    .slice(0, 5)
    .map((record) => `${record.position || ''} ${record.project || ''} / ${record.code || ''} / ${record.shooter || ''} / ${record.country || ''}`.trim())
    .join('\n');
}

function reviewRecord({ status, type, suggestion, reason, ad = null, record = null, candidates = [], strategy = '' }) {
  const firstCandidate = record || (candidates && candidates[0]) || null;
  return {
    fields: {
      '处理状态': status,
      '问题类型': type,
      '处理建议': suggestion,
      '原因': reason,
      'XMP行号': ad ? String(ad.sourceRow || '') : '',
      'XMP项目': ad ? valueToText(ad.project) : '',
      'XMP code': ad ? valueToText(ad.code) : '',
      'XMP投手': ad ? valueToText(ad.shooter) : '',
      'XMP国家': ad ? valueToText(ad.country) : '',
      'XMP花费': ad ? metricText(ad.metrics, 'spend') : '',
      'XMP展示次数': ad ? metricText(ad.metrics, 'impressions') : '',
      'XMP点击量': ad ? metricText(ad.metrics, 'clicks') : '',
      'XMP注册人数': ad ? metricText(ad.metrics, 'registrations') : '',
      'XMP首存人数': ad ? metricText(ad.metrics, 'firstDeposits') : '',
      '晨报行号': firstCandidate ? String(firstCandidate.position || '') : '',
      '晨报项目': firstCandidate ? valueToText(firstCandidate.project) : '',
      '晨报 code': firstCandidate ? valueToText(firstCandidate.code) : '',
      '晨报投手': firstCandidate ? valueToText(firstCandidate.shooter) : '',
      '晨报国家': firstCandidate ? valueToText(firstCandidate.country) : '',
      '候选数量': String((candidates && candidates.length) || (record ? 1 : 0)),
      '候选摘要': candidateSummary(candidates && candidates.length ? candidates : record ? [record] : []),
      '匹配策略': strategy,
    },
  };
}

function matchedReviewRows(matches) {
  return matches.map((match) => reviewRecord({
    status: '已自动写入',
    type: '匹配成功',
    suggestion: '无需处理；已写入ai匹配表',
    reason: '项目+code+投手+国家唯一一致',
    ad: match.ad,
    record: match.record,
    candidates: [match.record],
    strategy: match.strategy,
  }));
}

function crawlFailureReviewRows(items) {
  return items.map((item) => reviewRecord({
    status: '待人工确认',
    type: '抓取失败',
    suggestion: item.candidates.length
      ? '先确认XMP抓取是否确实失败；如有真实数据，再人工补入ai匹配表对应行'
      : '先确认XMP是否漏抓；如晨报缺该项目，请补维护晨报/投手表',
    reason: item.reason,
    ad: item.ad,
    candidates: item.candidates,
    strategy: '抓取失败优先分流',
  }));
}

function shooterMismatchReviewRows(items) {
  return items.map((item) => reviewRecord({
    status: '待人工确认',
    type: '投手不一致',
    suggestion: '核对XMP投手与晨报投手，以实际归属为准；确认后修正投手或手动补数',
    reason: item.reason,
    ad: item.ad,
    candidates: item.candidates,
    strategy: 'project+code+country',
  }));
}

function unmatchedReviewRows(items) {
  return items.map((item) => reviewRecord({
    status: '待人工确认',
    type: 'XMP有，晨报/投手表未匹配',
    suggestion: '检查晨报是否缺项目、code、国家，或XMP命名是否异常；确认后补维护表或手动补数',
    reason: item.reason,
    ad: item.ad,
    candidates: item.candidates || [],
    strategy: 'project+code+shooter+country',
  }));
}

function shooterOnlyReviewRows(records) {
  return records.map((record) => reviewRecord({
    status: '待人工确认',
    type: '晨报/投手表有，XMP没有',
    suggestion: '确认是否停投、XMP漏抓，或项目/code/投手/国家维护不一致',
    reason: '晨报/投手表有该记录，但XMP原始数据中没有可自动写入的匹配行',
    record,
    candidates: [record],
    strategy: 'source_without_xmp',
  }));
}

function buildMatchRecord(sourceRecord, sourceFields, matchByRecordId) {
  const record = buildTargetRecord(sourceRecord, normalFields(sourceFields), matchByRecordId);
  const match = matchByRecordId.get(sourceRecord.record_id);
  record.fields[METRIC_FIELDS.spend] = match ? match.ad.metrics.spend ?? 0 : 0;
  record.fields[METRIC_FIELDS.impressions] = match ? match.ad.metrics.impressions ?? 0 : 0;
  record.fields[METRIC_FIELDS.clicks] = match ? match.ad.metrics.clicks ?? 0 : 0;
  record.fields[METRIC_FIELDS.registrations] = match ? match.ad.metrics.registrations ?? 0 : 0;
  record.fields[METRIC_FIELDS.firstDeposits] = match ? match.ad.metrics.firstDeposits ?? 0 : 0;
  return record;
}

async function writeAiMatchTable({ feishu, baseUrl, businessDate, xmpFilePath }) {
  const appToken = await feishu.resolveBitableAppToken(baseUrl);
  const source = await findShooterSource(feishu, appToken, baseUrl, businessDate);
  const existingTarget = await findTargetMatchTable(feishu, appToken, businessDate);
  const target = existingTarget || await createTargetMatchTable(feishu, appToken, source, businessDate);

  const adsRows = readAdsRows(feishu, xmpFilePath);
  const matched = matchAdsToRecords(adsRows, source.records);
  const matchByRecordId = new Map(matched.matches.map((match) => [match.record.recordId, match]));
  const assignedRecordIds = new Set(matched.matches.map((match) => match.record.recordId));
  for (const item of matched.crawlFailures) {
    for (const candidate of item.candidates) assignedRecordIds.add(candidate.recordId);
  }
  for (const item of matched.shooterMismatches) {
    for (const candidate of item.candidates) assignedRecordIds.add(candidate.recordId);
  }
  for (const item of matched.duplicateRecords) {
    for (const candidate of item.candidates) assignedRecordIds.add(candidate.recordId);
  }
  const shooterOnlyRecords = source.records.filter((record) => !assignedRecordIds.has(record.recordId));

  const targetRecords = source.rawRecords.map((record) => buildMatchRecord(record, source.fields, matchByRecordId));
  const deletedRows = await clearTableRecords(feishu, appToken, target.table_id);
  await feishu.batchCreateRecords(appToken, target.table_id, targetRecords);
  const datePrefix = paddedDateLabel(businessDate);
  const duplicateReviewRows = unmatchedReviewRows(matched.duplicateRecords.map((item) => ({
    ...item,
    reason: item.reason,
  })));
  const resultTables = {
    matched: await writeResultTable(feishu, appToken, `${datePrefix}-匹配成功`, matchedReviewRows(matched.matches)),
    crawlFailure: await writeResultTable(feishu, appToken, `${datePrefix}-抓取失败`, crawlFailureReviewRows(matched.crawlFailures)),
    shooterMismatch: await writeResultTable(feishu, appToken, `${datePrefix}-投手不一致`, shooterMismatchReviewRows(matched.shooterMismatches)),
    unmatched: await writeResultTable(
      feishu,
      appToken,
      `${datePrefix}-未匹配`,
      [...unmatchedReviewRows(matched.unmatched), ...duplicateReviewRows]
    ),
    shooterOnly: await writeResultTable(feishu, appToken, `${datePrefix}-晨报有XMP没有`, shooterOnlyReviewRows(shooterOnlyRecords)),
  };

  return {
    appToken,
    sourceTableName: source.table.name,
    sourceTableId: source.table.table_id,
    targetTableName: target.name,
    targetTableId: target.table_id,
    targetCreated: !!target.created,
    viewReplica: target.viewReplica || null,
    targetUrl: tableUrlFromAppToken(baseUrl, appToken, target.table_id),
    adsRows: adsRows.length,
    sourceRows: source.records.length,
    matchedRows: matched.matches.length,
    writtenRows: targetRecords.length,
    deletedRows,
    unmatchedRows: matched.unmatched.length,
    crawlFailureRows: matched.crawlFailures.length,
    shooterMismatchRows: matched.shooterMismatches.length,
    shooterOnlyRows: shooterOnlyRecords.length,
    duplicateRows: matched.duplicateRecords.length,
    resultTables,
  };
}

async function reply(messageId, text) {
  const feishu = await new FeishuClient().init();
  await feishu.replyText(messageId, text);
}

async function handleFileMessage(message, summary) {
  if (config.xmpSourceChatId && message.chat_id !== config.xmpSourceChatId) return;

  const businessDate = standardXmpDate(summary.fileName);
  if (!businessDate) {
    logStep({
      event: 'xmp_file_ignored',
      chatId: message.chat_id,
      fileName: summary.fileName,
      reason: 'not_standard_middle_version',
    });
    return;
  }

  const feishu = await new FeishuClient().init();
  const outputDir = path.join(cacheRoot, 'incoming', businessDate);
  const outputPath = path.join(outputDir, `${summary.messageId}-${safeName(summary.fileName)}`);
  const downloaded = await feishu.downloadMessageResourceToFile(summary.messageId, summary.fileKey, outputPath, 'file');
  const entry = {
    receivedAt: new Date().toISOString(),
    chatId: message.chat_id,
    messageId: summary.messageId,
    fileKey: summary.fileKey,
    fileName: summary.fileName,
    businessDate,
    outputPath: downloaded.outputPath,
    bytes: downloaded.bytes,
  };
  rememberFile(entry);
  logStep({ event: 'xmp_file_cached', ...entry });
}

async function handleTextMessage(message, text) {
  if (!shouldTreatAsCommand(message, text)) return;

  const businessDate = parseCommandDate(text);
  const fileEntry = latestFileForDate(businessDate);
  if (!fileEntry) {
    await reply(
      message.message_id,
      `没有找到 ${businessDate} 的标准 XMP 文件。请确认 xmp数据整合分发正式群里已经发送 crawler广告数据报告_${businessDate}.xlsx。`
    );
    return;
  }

  await reply(message.message_id, `收到，开始处理 ${businessDate} 的 XMP 晨报匹配。`);
  try {
    const feishu = await new FeishuClient().init();
    const result = await writeAiMatchTable({
      feishu,
      baseUrl: config.shooterBaseUrl,
      businessDate,
      xmpFilePath: fileEntry.outputPath,
    });
    await reply(
      message.message_id,
      [
        `处理完成：${result.targetTableName}`,
        `目标表：${result.targetCreated ? '新建' : '复用并重写'}`,
        `投手表：${result.sourceTableName}`,
        `XMP数据：${result.adsRows} 条`,
        `投手表：${result.sourceRows} 条`,
        `匹配成功：${result.matchedRows} 条`,
        `抓取失败：${result.crawlFailureRows} 条`,
        `投手不一致：${result.shooterMismatchRows} 条`,
        `XMP未匹配：${result.unmatchedRows + result.duplicateRows} 条`,
        `晨报有XMP没有：${result.shooterOnlyRows} 条`,
        `清空旧记录：${result.deletedRows} 条`,
        `写入ai匹配表：${result.writtenRows} 条`,
        result.targetUrl,
      ].join('\n')
    );
  } catch (error) {
    const details = error.details || { message: error.message };
    logStep({ event: 'xmp_match_failed', businessDate, details });
    await reply(message.message_id, `处理失败：${details.msg || details.message || '未知错误'}`);
  }
}

async function handleMessage(data) {
  const message = data && data.message;
  if (!message || !message.message_id) return;
  if (processedMessageIds.has(message.message_id)) return;
  processedMessageIds.add(message.message_id);
  if (processedMessageIds.size > 5000) processedMessageIds.clear();

  const summary = summarizeMessage(message);
  const text = parseMessageText(message);
  logStep({ event: 'viklik_message', ...summary, text });

  if (message.message_type === 'file') {
    await handleFileMessage(message, summary);
    return;
  }
  if (message.message_type === 'text') {
    await handleTextMessage(message, text);
  }
}

async function main() {
  if (!config.shooterBaseUrl) {
    throw new Error('缺少 FEISHU_SHOOTER_BASE_URL');
  }

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
  });
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    domain: Lark.Domain.Lark,
  });
  wsClient.start({ eventDispatcher: dispatcher });

  console.log('viklik XMP morning matching bot started');
  console.log(`env: ${config.envPath}`);
}

main().catch((error) => {
  console.log(error.stack || error.message);
  process.exitCode = 1;
});
