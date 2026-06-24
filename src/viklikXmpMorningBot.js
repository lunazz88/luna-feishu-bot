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
const reviewAppRegistryPath = path.join(cacheRoot, 'review-app-registry.json');
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

const REVIEW_TABLE_FIELDS = {
  '抓取失败': [
    '处理状态',
    '项目',
    'code',
    'XMP原始code',
    '国家',
    'XMP投手',
    'XMP原始投手',
    '晨报投手',
    '抓取状态',
    '花费金额',
    '展示次数',
    '点击量',
    '注册人数',
    '首存人数',
    'XMP行号',
    '晨报行号',
  ],
  '投手不一致': [
    '处理状态',
    '项目',
    'code',
    'XMP原始code',
    '国家',
    'XMP投手',
    'XMP原始投手',
    '晨报投手',
    '花费金额',
    '展示次数',
    '点击量',
    '注册人数',
    '首存人数',
    'XMP行号',
    '晨报行号',
    '原因',
  ],
  'XMP有晨报没有': [
    '处理状态',
    '项目',
    'code',
    'XMP原始code',
    '国家',
    'XMP投手',
    'XMP原始投手',
    '花费金额',
    '展示次数',
    '点击量',
    '注册人数',
    '首存人数',
    'XMP行号',
    '晨报行号',
    '原因',
  ],
  '晨报有XMP没有': [
    '处理状态',
    '项目',
    'code',
    '国家',
    '晨报投手',
    '花费金额',
    '展示次数',
    '点击量',
    '注册人数',
    '首存人数',
    '晨报行号',
    '原因',
  ],
};

const DEFAULT_REVIEW_FIELDS = [
  '处理状态',
  '项目',
  'code',
  'XMP原始code',
  '国家',
  'XMP投手',
  'XMP原始投手',
  '晨报投手',
  '花费金额',
  '展示次数',
  '点击量',
  '注册人数',
  '首存人数',
  'XMP行号',
  '晨报行号',
  '原因',
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

function loadReviewAppRegistry() {
  if (!fs.existsSync(reviewAppRegistryPath)) return { appsByDate: {} };
  return JSON.parse(fs.readFileSync(reviewAppRegistryPath, 'utf8'));
}

function saveReviewAppRegistry(registry) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.writeFileSync(reviewAppRegistryPath, JSON.stringify(registry, null, 2));
}

function rememberReviewApp(businessDate, entry) {
  const registry = loadReviewAppRegistry();
  registry.appsByDate[businessDate] = {
    ...entry,
    updatedAt: new Date().toISOString(),
  };
  saveReviewAppRegistry(registry);
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

function ruleLookupText(value) {
  return valueToText(value)
    .trim()
    .toLowerCase()
    .replace(/[，、；;]/g, ',')
    .replace(/\s+/g, '');
}

function countryFromProject(project) {
  const match = valueToText(project).match(/-([A-Za-z]{2})\s*$/);
  return match ? match[1].toUpperCase() : '';
}

function normalizedCode(value) {
  return normalizeCommon({ code: value }).codeStrong;
}

function normalizedProject(value) {
  return normalizeCommon({ project: value }).projectNorm;
}

function normalizedName(value) {
  return normalizeCommon({ shooter: value }).shooterNorm;
}

async function loadProjectRules(feishu) {
  if (!config.xmpProjectRulesUrl) return new Map();
  try {
    const values = await feishu.readSheetValues(config.xmpProjectRulesUrl, 'A1:H5000');
    const headers = (values[0] || []).map((header) => valueToText(header).replace(/\s+/g, ''));
    const indexOf = (names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
    const irregularIndex = indexOf(['不规则情况', 'others', 'Others', 'other', 'Other', '别名', '项目别名']);
    const projectIndex = indexOf(['项目名称', '项目', 'project', 'Project']);
    const codeIndex = indexOf(['Code', 'code']);
    const standardUserIndex = indexOf(['标准用户名']);
    const shooterIndex = indexOf(['投手']);
    const orderIndex = indexOf(['顺序', 'order', 'Order']);
    const rules = new Map();

    for (const row of values.slice(1)) {
      const irregular = irregularIndex >= 0 ? valueToText(row[irregularIndex]) : '';
      const project = projectIndex >= 0 ? valueToText(row[projectIndex]) : '';
      if (!irregular || !project) continue;
      rules.set(ruleLookupText(irregular), {
        project,
        order: orderIndex >= 0 ? valueToText(row[orderIndex]) : '',
        code: codeIndex >= 0 ? valueToText(row[codeIndex]) : '',
        standardUser: standardUserIndex >= 0 ? valueToText(row[standardUserIndex]) : '',
        shooter: shooterIndex >= 0 ? valueToText(row[shooterIndex]) : '',
        country: countryFromProject(project),
      });
    }
    logStep({ event: 'xmp_project_rules_loaded', rows: rules.size });
    return rules;
  } catch (error) {
    logStep({
      event: 'xmp_project_rules_load_failed',
      details: error.details || { message: error.message },
    });
    return new Map();
  }
}

function applyProjectRules(adsRows, rules) {
  if (!rules || !rules.size) return adsRows;
  return adsRows.map((row) => {
    const rule = rules.get(ruleLookupText(row.project));
    if (!rule) return row;
    return normalizeCommon({
      ...row,
      originalProject: row.project,
      originalCode: row.code,
      originalShooter: row.shooter,
      originalCountry: row.country,
      project: rule.project || row.project,
      code: rule.standardUser || rule.code || row.code,
      shooter: rule.shooter || row.shooter,
      country: rule.country || row.country,
      normalizedByRule: true,
      projectRuleOrder: rule.order,
      standardUser: rule.standardUser || '',
      standardShooter: rule.shooter || '',
    });
  });
}

async function loadCodeRules(feishu) {
  if (!config.xmpCodeRulesUrl) return { byProjectCode: new Map(), rows: 0 };
  try {
    const values = await feishu.readSheetValues(config.xmpCodeRulesUrl, 'A1:F5000');
    const headers = (values[0] || []).map((header) => valueToText(header).replace(/\s+/g, ''));
    const indexOf = (names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
    const projectIndex = indexOf(['项目名称', '项目']);
    const standardUserIndex = indexOf(['标准用户名']);
    const shooterIndex = indexOf(['投手列', '投手']);
    const lineTypeIndex = indexOf(['总分情况']);
    const codeIndex = indexOf(['Code', 'code']);
    const noteIndex = indexOf(['备注']);
    const byProjectCode = new Map();
    let rows = 0;

    for (let i = 1; i < values.length; i += 1) {
      const row = values[i] || [];
      const project = projectIndex >= 0 ? valueToText(row[projectIndex]) : '';
      const standardUser = standardUserIndex >= 0 ? valueToText(row[standardUserIndex]) : '';
      const shooter = shooterIndex >= 0 ? valueToText(row[shooterIndex]) : '';
      if (!project || !standardUser) continue;

      const rule = {
        rowNumber: i + 1,
        project,
        projectNorm: normalizedProject(project),
        standardUser,
        standardCode: normalizedCode(standardUser),
        shooter,
        shooterNorm: normalizedName(shooter),
        country: countryFromProject(project),
        countryNorm: normalizedName(countryFromProject(project)),
        lineType: lineTypeIndex >= 0 ? valueToText(row[lineTypeIndex]) : '',
        xmpCode: codeIndex >= 0 ? valueToText(row[codeIndex]) : '',
        note: noteIndex >= 0 ? valueToText(row[noteIndex]) : '',
      };
      rows += 1;

      const codeCandidates = new Set([
        normalizedCode(rule.xmpCode),
        normalizedCode(rule.standardUser),
      ].filter(Boolean));
      for (const code of codeCandidates) {
        const key = [rule.projectNorm, code].join('\u0001');
        if (!byProjectCode.has(key)) byProjectCode.set(key, []);
        byProjectCode.get(key).push(rule);
      }
    }

    if (!rows) throw new Error('标准用户名规则表为空');
    logStep({ event: 'xmp_code_rules_loaded', rows });
    return { byProjectCode, rows };
  } catch (error) {
    logStep({
      event: 'xmp_code_rules_load_failed',
      details: error.details || { message: error.message },
    });
    throw error;
  }
}

function pickCodeRule(row, codeRules) {
  const candidates = codeRules.byProjectCode.get([row.projectNorm, row.codeStrong].join('\u0001')) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((rule) => rule.shooterNorm && rule.shooterNorm === row.shooterNorm) || candidates[0];
}

function applyCodeRules(adsRows, codeRules) {
  if (!codeRules || !codeRules.byProjectCode || !codeRules.byProjectCode.size) {
    return adsRows.map((row) => ({
      ...row,
      xmpOriginalCode: row.originalCode || row.code,
      xmpOriginalShooter: row.originalShooter || row.shooter,
      codeRuleMatched: false,
    }));
  }

  return adsRows.map((row) => {
    const rule = pickCodeRule(row, codeRules);
    const originalCode = row.xmpOriginalCode || row.originalCode || row.code;
    const originalShooter = row.xmpOriginalShooter || row.originalShooter || row.shooter;
    if (!rule && row.normalizedByRule && row.standardUser) {
      return normalizeCommon({
        ...row,
        xmpOriginalCode: originalCode,
        xmpOriginalShooter: originalShooter,
        code: row.standardUser,
        shooter: row.standardShooter || row.shooter,
        codeRuleMatched: true,
        codeRuleSource: 'project_rule',
      });
    }
    if (!rule) {
      return normalizeCommon({
        ...row,
        xmpOriginalCode: originalCode,
        xmpOriginalShooter: originalShooter,
        codeRuleMatched: false,
      });
    }

    return normalizeCommon({
      ...row,
      xmpOriginalCode: originalCode,
      xmpOriginalShooter: originalShooter,
      code: rule.standardUser || row.code,
      shooter: rule.shooter || row.shooter,
      country: row.country || rule.country,
      codeRuleMatched: true,
      codeRuleRow: rule.rowNumber,
      codeRuleLineType: rule.lineType,
      standardUser: rule.standardUser,
      standardShooter: rule.shooter,
    });
  });
}

function matchKey(row) {
  return [row.projectNorm, row.codeStrong, row.shooterNorm, row.countryNorm].join('\u0001');
}

function projectCodeCountryKey(row) {
  return [row.projectNorm, row.codeStrong, row.countryNorm].join('\u0001');
}

function hasExactMatchParts(row) {
  return Boolean(row.projectNorm && row.codeStrong && row.shooterNorm && row.countryNorm);
}

function hasProjectCodeCountryParts(row) {
  return Boolean(row.projectNorm && row.codeStrong && row.countryNorm);
}

function isGroupingOnlyRecord(row) {
  return Boolean(row.projectNorm && !row.codeStrong && !row.shooterNorm && !row.countryNorm);
}

function isReviewableSourceRecord(row) {
  return Boolean(row.projectNorm) && !isGroupingOnlyRecord(row);
}

function isCrawlFailure(ad) {
  return valueToText(ad.crawlStatus).trim() !== '';
}

function hasMetricValue(row) {
  const metrics = row.metrics || {};
  return ['spend', 'impressions', 'clicks', 'registrations', 'firstDeposits']
    .some((key) => metrics[key] !== null && metrics[key] !== undefined);
}

function isReviewableAdsRow(row) {
  if (isCrawlFailure(row)) return true;
  if (!row.projectNorm) return false;
  if (row.codeStrong || row.shooterNorm) return true;
  return hasMetricValue(row);
}

function indexRecords(records, keyFn) {
  const recordIndex = new Map();
  for (const record of records) {
    if (keyFn === matchKey && !hasExactMatchParts(record)) continue;
    if (keyFn === projectCodeCountryKey && !hasProjectCodeCountryParts(record)) continue;
    const key = keyFn(record);
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
        reason: `XMP抓取状态非空：${valueToText(ad.crawlStatus)}`,
      });
      continue;
    }

    if (!ad.codeRuleMatched) {
      unmatched.push({
        ad,
        candidates: [],
        reason: `标准用户名规则未命中：项目=${valueToText(ad.project)}，XMP原始code=${valueToText(ad.xmpOriginalCode || ad.code)}`,
      });
      continue;
    }

    if (candidates.length === 1) {
      matches.push({ ad, record: candidates[0], strategy: 'project+standard_user+shooter+country' });
    } else if (candidates.length > 1) {
      duplicateRecords.push({
        ad,
        candidates,
        reason: '晨报/投手表存在多条相同 项目+标准用户名+投手+国家，无法自动判断唯一记录',
      });
    } else if (projectCodeCountryCandidates.length) {
      shooterMismatches.push({
        ad,
        candidates: projectCodeCountryCandidates,
        reason: '项目+标准用户名+国家一致，但投手不一致',
      });
    } else {
      unmatched.push({
        ad,
        candidates: [],
        reason: 'XMP有该行，但晨报/投手表中找不到相同 项目+标准用户名+国家',
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

function reviewFieldsFor(tableName) {
  return REVIEW_TABLE_FIELDS[tableName] || DEFAULT_REVIEW_FIELDS;
}

function filterReviewRowsForTable(rows, tableName) {
  const fieldNames = new Set(reviewFieldsFor(tableName));
  return rows.map((row) => ({
    fields: Object.fromEntries(
      Object.entries(row.fields || {}).filter(([fieldName]) => fieldNames.has(fieldName))
    ),
  }));
}

async function ensureResultTable(feishu, appToken, tableName) {
  const reviewFields = reviewFieldsFor(tableName);
  let tables = await feishu.listTables(appToken);
  let table = tables.find((item) => item.name === tableName);
  let fields = table ? await feishu.listFields(appToken, table.table_id) : [];
  if (table && fields.some((field) => !reviewFields.includes(field.field_name))) {
    await feishu.deleteTable(appToken, table.table_id);
    tables = await feishu.listTables(appToken);
    table = null;
    fields = [];
  }

  if (!table) {
    table = await feishu.createTable(
      appToken,
      tableName,
      [{ field_name: reviewFields[0], type: 1, ui_type: 'Text' }],
      { defaultViewName: '表格' }
    );
    table.name = tableName;
    fields = await feishu.listFields(appToken, table.table_id);
  }

  const existingNames = new Set(fields.map((field) => field.field_name));
  if (!existingNames.has(reviewFields[0])) {
    const primaryField = fields.find((field) => field.is_primary) || fields[0];
    if (primaryField) {
      await feishu.updateField(appToken, table.table_id, primaryField.field_id, {
        field_name: reviewFields[0],
        type: 1,
        ui_type: 'Text',
      });
      existingNames.add(reviewFields[0]);
    }
  }
  for (const fieldName of reviewFields) {
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

async function deleteResultTableIfExists(feishu, appToken, tableName) {
  const tables = await feishu.listTables(appToken);
  const table = tables.find((item) => item.name === tableName);
  if (!table) return false;
  await feishu.deleteTable(appToken, table.table_id);
  return true;
}

async function writeResultTable(feishu, appToken, tableName, rows) {
  const table = await ensureResultTable(feishu, appToken, tableName);
  const deletedRows = await clearTableRecords(feishu, appToken, table.table_id);
  await feishu.batchCreateRecords(appToken, table.table_id, filterReviewRowsForTable(rows, tableName));
  return {
    tableName,
    tableId: table.table_id,
    rows: rows.length,
    deletedRows,
  };
}

function reviewAppName(businessDate) {
  return `${paddedDateLabel(businessDate)}-ai匹配核对表`;
}

function reviewAppUrl(baseUrl, appToken) {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/base/${appToken}`;
}

async function ensureReviewApp(feishu, baseUrl, businessDate) {
  const registry = loadReviewAppRegistry();
  const existing = registry.appsByDate[businessDate];
  if (existing && existing.appToken) {
    try {
      await feishu.listTables(existing.appToken);
      return {
        ...existing,
        created: false,
      };
    } catch (error) {
      logStep({
        event: 'review_app_registry_stale',
        businessDate,
        details: error.details || { message: error.message },
      });
    }
  }

  const name = reviewAppName(businessDate);
  const created = await feishu.createBitable(name, { sourceUrl: baseUrl });
  await feishu.setTenantEditable(created.appToken);
  await feishu.grantResultChatEdit(created.appToken);
  const entry = {
    appToken: created.appToken,
    name,
    url: created.url || reviewAppUrl(baseUrl, created.appToken),
    defaultTableId: created.defaultTableId,
  };
  rememberReviewApp(businessDate, entry);
  return {
    ...entry,
    created: true,
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

function reviewRecord({ status, type, suggestion, reason, ad = null, record = null, candidates = [], strategy = '' }) {
  const firstCandidate = record || (candidates && candidates[0]) || null;
  const project = ad ? ad.project : firstCandidate ? firstCandidate.project : '';
  const code = ad ? ad.code : firstCandidate ? firstCandidate.code : '';
  const country = ad ? ad.country : firstCandidate ? firstCandidate.country : '';
  return {
    fields: {
      '处理状态': status,
      '问题类型': type,
      '处理建议': suggestion,
      '原因': reason,
      '项目': valueToText(project),
      'code': valueToText(code),
      'XMP原始code': ad ? valueToText(ad.xmpOriginalCode || ad.originalCode || ad.code) : '',
      '国家': valueToText(country),
      'XMP投手': ad ? valueToText(ad.shooter) : '',
      'XMP原始投手': ad ? valueToText(ad.xmpOriginalShooter || ad.originalShooter || ad.shooter) : '',
      '晨报投手': firstCandidate ? valueToText(firstCandidate.shooter) : '',
      '抓取状态': ad ? valueToText(ad.crawlStatus) : '',
      '花费金额': ad ? metricText(ad.metrics, 'spend') : '',
      '展示次数': ad ? metricText(ad.metrics, 'impressions') : '',
      '点击量': ad ? metricText(ad.metrics, 'clicks') : '',
      '注册人数': ad ? metricText(ad.metrics, 'registrations') : '',
      '首存人数': ad ? metricText(ad.metrics, 'firstDeposits') : '',
      'XMP行号': ad ? String(ad.sourceRow || '') : '',
      '晨报行号': firstCandidate ? String(firstCandidate.position || '') : '',
    },
  };
}

function crawlFailureReviewRows(items) {
  return items.map((item) => reviewRecord({
    status: '待人工确认',
    type: '抓取失败',
    suggestion: item.candidates.length
      ? '人工补抓后填入数值'
      : '人工确认是否需新增晨报记录',
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
    suggestion: '确认以哪个投手为准',
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
    suggestion: '确认晨报是否缺记录',
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
    suggestion: '确认XMP是否漏抓',
    reason: '晨报有，XMP没有',
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

async function syncMatchTableRecords(feishu, appToken, target, targetRecords) {
  const existingRecords = await feishu.listRecords(appToken, target.table_id);
  if (existingRecords.length === targetRecords.length) {
    const updates = targetRecords.map((record, index) => ({
      record_id: existingRecords[index].record_id,
      fields: record.fields,
    }));
    await feishu.batchUpdateRecords(appToken, target.table_id, updates);
    return {
      mode: 'update_existing_rows',
      deletedRows: 0,
      writtenRows: updates.length,
    };
  }

  const deletedRows = await clearTableRecords(feishu, appToken, target.table_id);
  await feishu.batchCreateRecords(appToken, target.table_id, targetRecords);
  return {
    mode: 'recreate_rows',
    deletedRows,
    writtenRows: targetRecords.length,
  };
}

async function writeAiMatchTable({ feishu, baseUrl, businessDate, xmpFilePath }) {
  const appToken = await feishu.resolveBitableAppToken(baseUrl);
  const source = await findShooterSource(feishu, appToken, baseUrl, businessDate);
  const existingTarget = await findTargetMatchTable(feishu, appToken, businessDate);
  const target = existingTarget || await createTargetMatchTable(feishu, appToken, source, businessDate);

  const projectRules = await loadProjectRules(feishu);
  const codeRules = await loadCodeRules(feishu);
  const projectNormalizedAdsRows = applyProjectRules(readAdsRows(feishu, xmpFilePath), projectRules);
  const allAdsRows = applyCodeRules(projectNormalizedAdsRows, codeRules);
  const adsRows = allAdsRows.filter(isReviewableAdsRow);
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
  const shooterOnlyRecords = source.records.filter((record) => isReviewableSourceRecord(record) && !assignedRecordIds.has(record.recordId));

  const targetRecords = source.rawRecords.map((record) => buildMatchRecord(record, source.fields, matchByRecordId));
  const targetSync = await syncMatchTableRecords(feishu, appToken, target, targetRecords);
  const reviewApp = await ensureReviewApp(feishu, baseUrl, businessDate);
  await deleteResultTableIfExists(feishu, reviewApp.appToken, '匹配成功');
  const duplicateReviewRows = unmatchedReviewRows(matched.duplicateRecords.map((item) => ({
    ...item,
    reason: item.reason,
  })));
  const resultTables = {
    crawlFailure: await writeResultTable(feishu, reviewApp.appToken, '抓取失败', crawlFailureReviewRows(matched.crawlFailures)),
    shooterMismatch: await writeResultTable(feishu, reviewApp.appToken, '投手不一致', shooterMismatchReviewRows(matched.shooterMismatches)),
    unmatched: await writeResultTable(
      feishu,
      reviewApp.appToken,
      'XMP有晨报没有',
      [...unmatchedReviewRows(matched.unmatched), ...duplicateReviewRows]
    ),
    shooterOnly: await writeResultTable(feishu, reviewApp.appToken, '晨报有XMP没有', shooterOnlyReviewRows(shooterOnlyRecords)),
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
    reviewApp,
    targetSyncMode: targetSync.mode,
    adsRows: adsRows.length,
    ignoredAdsRows: allAdsRows.length - adsRows.length,
    codeRuleRows: codeRules.rows,
    codeRuleMissRows: matched.unmatched.filter((item) => !item.ad.codeRuleMatched).length,
    sourceRows: source.records.length,
    matchedRows: matched.matches.length,
    writtenRows: targetSync.writtenRows,
    deletedRows: targetSync.deletedRows,
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
        `XMP空白项目行：${result.ignoredAdsRows} 条`,
        `标准用户名规则：${result.codeRuleRows} 条`,
        `规则未命中：${result.codeRuleMissRows} 条`,
        `投手表：${result.sourceRows} 条`,
        `匹配成功：${result.matchedRows} 条`,
        `抓取失败：${result.crawlFailureRows} 条`,
        `投手不一致：${result.shooterMismatchRows} 条`,
        `XMP未匹配：${result.unmatchedRows + result.duplicateRows} 条`,
        `晨报有XMP没有：${result.shooterOnlyRows} 条`,
        `清空旧记录：${result.deletedRows} 条`,
        `写入ai匹配表：${result.writtenRows} 条`,
        result.targetUrl,
        `核对表：${result.reviewApp.name}`,
        result.reviewApp.url,
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
