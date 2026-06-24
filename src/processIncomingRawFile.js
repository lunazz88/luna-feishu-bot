const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { matchAdsToRecords, valueToNumber, valueToText } = require('./matcher');

const METRIC_FIELDS = {
  spend: '花费金额',
  impressions: '展示次数',
  clicks: '点击量',
  registrations: '注册人数',
  firstDeposits: '首存人数',
};

const REVIEW_FIELD_NAMES = [
  '问题类型',
  '匹配失败原因',
  'XMP原始项目',
  'XMP原始code',
  'XMP原始投手',
  '晨报表项目',
  '晨报表code',
  '晨报表投手',
  '建议以谁为准',
  '处理建议',
];

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(file, rows) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, '\ufeff' + rows.map((row) => row.map(csvCell).join(',')).join('\n'), 'utf8');
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function safeName(name) {
  return String(name || 'daily-data')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
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

function tableUrl(baseUrl, appToken, tableId) {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/base/${appToken}?table=${tableId}`;
}

function tableUrlFromAppToken(baseUrl, appToken, tableId) {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/base/${appToken}?table=${tableId}`;
}

function uniqueTableName(tables, wantedName) {
  if (!tables.some((table) => table.name === wantedName)) return wantedName;
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
  return `${wantedName}_${stamp}`;
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

async function createCorrectionTable(feishu, appToken, source, tableName) {
  const sourceFields = source.fields;
  const normalFields = sourceFields.filter((field) => field.type !== 20 && field.ui_type !== 'Formula');
  const formulaFields = sourceFields.filter((field) => field.type === 20 || field.ui_type === 'Formula');
  const primaryField = normalFields.find((field) => field.is_primary) || normalFields[0];
  const restNormalFields = normalFields.filter((field) => field !== primaryField);
  const fieldIdMap = new Map();

  const [defaultViewName] = config.resultViewNames.length ? config.resultViewNames : ['所有项目'];
  const created = await feishu.createTable(appToken, tableName, [cloneField(primaryField)], { defaultViewName });
  const defaultFields = await feishu.listFields(appToken, created.table_id);
  const createdPrimary = defaultFields.find((field) => field.is_primary) || defaultFields[0];
  if (!createdPrimary) throw new Error(`新建表失败：没有默认主字段 ${created.table_id}`);
  const updatedPrimary = await feishu.updateField(appToken, created.table_id, createdPrimary.field_id, cloneField(primaryField));
  fieldIdMap.set(primaryField.field_id, updatedPrimary.field_id || createdPrimary.field_id);

  for (const field of restNormalFields) {
    const createdField = await feishu.createField(appToken, created.table_id, cloneField(field));
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
    const createdField = await feishu.createField(appToken, created.table_id, copied);
    fieldIdMap.set(field.field_id, createdField.field_id);
  }

  return {
    table_id: created.table_id,
    normalFields,
    formulaFields,
    fieldIdMap: Object.fromEntries(fieldIdMap.entries()),
  };
}

function recordValueForTarget(field, value) {
  if (field.type === 20 || field.ui_type === 'Formula') return undefined;
  if (field.type === 2 || field.ui_type === 'Number' || field.ui_type === 'Currency') return valueToNumber(value);
  if (field.type === 11 || field.ui_type === 'User') {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((item) => item && typeof item === 'object')) return undefined;
    return value;
  }
  return valueToText(value);
}

function buildTargetRecord(sourceRecord, normalFields, matchByRecordId) {
  const fields = {};
  for (const field of normalFields) {
    const value = recordValueForTarget(field, sourceRecord.fields[field.field_name]);
    if (value !== undefined && value !== null && value !== '') fields[field.field_name] = value;
  }

  const match = matchByRecordId.get(sourceRecord.record_id);
  if (match) {
    fields[METRIC_FIELDS.spend] = match.ad.metrics.spend ?? 0;
    fields[METRIC_FIELDS.impressions] = match.ad.metrics.impressions ?? 0;
    fields[METRIC_FIELDS.clicks] = match.ad.metrics.clicks ?? 0;
    fields[METRIC_FIELDS.registrations] = match.ad.metrics.registrations ?? 0;
    fields[METRIC_FIELDS.firstDeposits] = match.ad.metrics.firstDeposits ?? 0;
  }

  if (!fields['项目']) fields['项目'] = '(空项目)';
  return { fields };
}

function reportUnmatchedRows(unmatched) {
  return [
    ['原始数据行号', '原始数据中的项目', '原始数据中的code', '原始数据中的投手', '国家', 'KPI', '花费', '展示', '点击', '注册', '首存', '原因'],
    ...unmatched.map(({ ad, reason }) => [
      ad.sourceRow,
      ad.project,
      ad.code,
      ad.shooter,
      ad.country,
      ad.kpiNorm,
      ad.metrics.spend ?? '',
      ad.metrics.impressions ?? '',
      ad.metrics.clicks ?? '',
      ad.metrics.registrations ?? '',
      ad.metrics.firstDeposits ?? '',
      reason,
    ]),
  ];
}

function reportReviewRows(review) {
  return [
    ['类型', '原始项目', '原始code', '原始投手', '国家', 'KPI', '投手表项目', '投手表code', '投手表投手', '匹配策略'],
    ...review.map((item) => [
      item.type,
      item.ad.project,
      item.ad.code,
      item.ad.shooter,
      item.ad.country,
      item.ad.kpiNorm,
      item.record ? item.record.project : '',
      item.record ? item.record.code : '',
      item.record ? item.record.shooter : '',
      item.strategy,
    ]),
  ];
}

function reportShooterUnmatchedRows(records) {
  return [
    ['投手表行号', '投手表项目', '投手表code', '投手表投手', '国家', 'KPI', '投手填花费金额', '投手填展示次数', '投手填点击量', '投手填注册人数', '投手填首存人数', '原因'],
    ...records.map((record) => [
      record.position,
      record.project,
      record.code,
      record.shooter,
      record.country,
      record.kpiNorm,
      record.currentMetrics.spend ?? '',
      record.currentMetrics.impressions ?? '',
      record.currentMetrics.clicks ?? '',
      record.currentMetrics.registrations ?? '',
      record.currentMetrics.firstDeposits ?? '',
      '投手表有该记录，但原始广告数据未匹配到',
    ]),
  ];
}

function isCrawlFailure(ad) {
  return /失败|无数据/.test(valueToText(ad.crawlStatus).trim());
}

async function createReplicatedTable(feishu, baseUrl, source, tableName) {
  const appToken = await feishu.resolveBitableAppToken(baseUrl);
  const tables = await feishu.listTables(appToken);
  const outputName = uniqueTableName(tables, tableName);
  const target = await createCorrectionTable(feishu, appToken, source, outputName);
  const viewReplica = await feishu.ensureGridViews(appToken, target.table_id, config.resultViewNames);
  return {
    appToken,
    tableId: target.table_id,
    tableName: outputName,
    normalFields: target.normalFields,
    formulaFields: target.formulaFields,
    viewReplica,
    url: tableUrlFromAppToken(baseUrl, appToken, target.table_id),
  };
}

async function ensureReviewFields(feishu, appToken, tableId, existingFields) {
  const fields = [...existingFields];
  const existingNames = new Set(fields.map((field) => field.field_name));
  for (const fieldName of REVIEW_FIELD_NAMES) {
    if (existingNames.has(fieldName)) continue;
    const created = await feishu.createField(appToken, tableId, {
      field_name: fieldName,
      type: 1,
      ui_type: 'Text',
    });
    fields.push({
      field_id: created.field_id,
      field_name: fieldName,
      type: 1,
      ui_type: 'Text',
    });
    existingNames.add(fieldName);
  }
  return fields;
}

async function createTableWithRecords(feishu, baseUrl, source, tableName, records) {
  const target = await createReplicatedTable(feishu, baseUrl, source, tableName);
  await feishu.grantResultChatEdit(target.appToken);
  await feishu.batchCreateRecords(target.appToken, target.tableId, records);
  return {
    ...target,
    rows: records.length,
  };
}

async function createReviewTableWithRecords(feishu, baseUrl, source, tableName, records) {
  const target = await createReplicatedTable(feishu, baseUrl, source, tableName);
  const fields = await ensureReviewFields(feishu, target.appToken, target.tableId, target.normalFields);
  await feishu.grantResultChatEdit(target.appToken);
  await feishu.batchCreateRecords(target.appToken, target.tableId, records);
  return {
    ...target,
    normalFields: fields,
    rows: records.length,
  };
}

function normalFields(fields) {
  return fields.filter((field) => field.type !== 20 && field.ui_type !== 'Formula');
}

function metricUpdateFields(match) {
  return {
    [METRIC_FIELDS.spend]: match.ad.metrics.spend ?? 0,
    [METRIC_FIELDS.impressions]: match.ad.metrics.impressions ?? 0,
    [METRIC_FIELDS.clicks]: match.ad.metrics.clicks ?? 0,
    [METRIC_FIELDS.registrations]: match.ad.metrics.registrations ?? 0,
    [METRIC_FIELDS.firstDeposits]: match.ad.metrics.firstDeposits ?? 0,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBitableCopyingError(error) {
  const details = error.details || {};
  const message = `${details.msg || ''} ${details.message || ''} ${error.message || ''}`;
  return /Bitable is copying|copying/i.test(message);
}

async function waitForCopiedBitable(feishu, appToken, options = {}) {
  const attempts = options.attempts || 18;
  const delayMs = options.delayMs || 4000;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const tables = await feishu.listTables(appToken);
      if (tables.length) return tables;
    } catch (error) {
      lastError = error;
      if (!isBitableCopyingError(error)) throw error;
    }
    await sleep(delayMs);
  }
  if (lastError) throw lastError;
  throw new Error('复制后的多维表格暂未就绪，请稍后重试');
}

async function copySourceBitableAsResult(feishu, sourceUrl, source, tableName, keepSourceRecordIds, updatesBySourceRecordId) {
  const copied = await feishu.copyBitable(sourceUrl, tableName);
  const copiedTables = await waitForCopiedBitable(feishu, copied.copiedAppToken);
  await feishu.setTenantEditable(copied.copiedAppToken);
  await feishu.grantResultChatEdit(copied.copiedAppToken);
  await feishu.grantSourceOwnerEdit(sourceUrl, copied.copiedAppToken);
  const targetTable = copiedTables.find((table) => table.name === source.table.name) || copiedTables[0];
  if (!targetTable) throw new Error(`复制多维表格后没有找到数据表：${tableName}`);

  for (const table of copiedTables) {
    if (table.table_id !== targetTable.table_id) {
      await feishu.deleteTable(copied.copiedAppToken, table.table_id);
    }
  }
  await feishu.renameTable(copied.copiedAppToken, targetTable.table_id, tableName);

  const target = await feishu.readBitableTable(copied.copiedAppToken, targetTable.table_id);
  const copiedBySourceRecordId = new Map();
  source.rawRecords.forEach((sourceRecord, index) => {
    const copiedRecord = target.rawRecords[index];
    if (copiedRecord) copiedBySourceRecordId.set(sourceRecord.record_id, copiedRecord);
  });

  const keepSet = new Set(keepSourceRecordIds);
  const deleteIds = [];
  for (const sourceRecord of source.rawRecords) {
    if (keepSet.has(sourceRecord.record_id)) continue;
    const copiedRecord = copiedBySourceRecordId.get(sourceRecord.record_id);
    if (copiedRecord) deleteIds.push(copiedRecord.record_id);
  }
  await feishu.batchDeleteRecords(copied.copiedAppToken, targetTable.table_id, deleteIds);

  const updates = [];
  for (const [sourceRecordId, fields] of updatesBySourceRecordId.entries()) {
    const copiedRecord = copiedBySourceRecordId.get(sourceRecordId);
    if (!copiedRecord) continue;
    updates.push({
      record_id: copiedRecord.record_id,
      fields,
    });
  }
  await feishu.batchUpdateRecords(copied.copiedAppToken, targetTable.table_id, updates);

  return {
    appToken: copied.copiedAppToken,
    tableId: targetTable.table_id,
    tableName,
    normalFields: normalFields(target.fields),
    formulaFields: target.fields.filter((field) => field.type === 20 || field.ui_type === 'Formula'),
    rows: keepSourceRecordIds.length,
    url: tableUrlFromAppToken(sourceUrl, copied.copiedAppToken, targetTable.table_id),
    copied,
  };
}

function valueForField(field, value) {
  if (field.type === 20 || field.ui_type === 'Formula') return undefined;

  if (field.type === 2 || field.ui_type === 'Number' || field.ui_type === 'Currency') {
    return valueToNumber(value);
  }

  if (field.type === 5 || field.ui_type === 'DateTime') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = valueToText(value).trim();
    if (!text) return undefined;
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (field.type === 11 || field.ui_type === 'User') {
    if (!Array.isArray(value)) return undefined;
    if (!value.every((item) => item && typeof item === 'object')) return undefined;
    return value;
  }

  return valueToText(value);
}

function setIfField(fields, fieldByName, names, value) {
  const target = names.find((name) => fieldByName.has(name));
  if (!target || value === undefined || value === null || value === '') return;

  const field = fieldByName.get(target);
  const converted = valueForField(field, value);
  if (converted === undefined || converted === null || converted === '') return;

  fields[target] = converted;
}

function buildAdRecordForTarget(ad, normalFields, sourceRecord = null) {
  const fields = {};
  if (sourceRecord) {
    for (const field of normalFields) {
      const value = recordValueForTarget(field, sourceRecord.fields[field.field_name]);
      if (value !== undefined && value !== null && value !== '') fields[field.field_name] = value;
    }
  }
  const fieldByName = new Map(normalFields.map((field) => [field.field_name, field]));

  setIfField(fields, fieldByName, ['日期'], ad.date);
  setIfField(fields, fieldByName, ['项目', '项目名称'], ad.project);
  setIfField(fields, fieldByName, ['Code', 'code', 'CODE'], ad.code);
  setIfField(fields, fieldByName, ['投手'], ad.shooter);
  setIfField(fields, fieldByName, ['国家'], ad.country);
  setIfField(fields, fieldByName, ['KPI(美金）', 'KPI'], ad.kpi ?? ad.kpiNorm);
  setIfField(fields, fieldByName, ['抓取状态', '抓取\n状态'], ad.crawlStatus);
  setIfField(fields, fieldByName, ['花费金额', '花费'], ad.metrics.spend ?? 0);
  setIfField(fields, fieldByName, ['展示次数', '展示数'], ad.metrics.impressions ?? 0);
  setIfField(fields, fieldByName, ['点击量', '点击数'], ad.metrics.clicks ?? 0);
  setIfField(fields, fieldByName, ['注册人数', '注册数'], ad.metrics.registrations ?? 0);
  setIfField(fields, fieldByName, ['首存人数', '首存数'], ad.metrics.firstDeposits ?? 0);

  if (!fields['项目'] && !fields['项目名称']) {
    setIfField(fields, fieldByName, ['项目', '项目名称'], '(空项目)');
  }
  return { fields };
}

function addReviewFields(record, details) {
  record.fields['问题类型'] = details.issueType || '';
  record.fields['匹配失败原因'] = details.reason || '';
  record.fields['XMP原始项目'] = details.ad ? valueToText(details.ad.project) : '';
  record.fields['XMP原始code'] = details.ad ? valueToText(details.ad.code) : '';
  record.fields['XMP原始投手'] = details.ad ? valueToText(details.ad.shooter) : '';
  record.fields['晨报表项目'] = details.record ? valueToText(details.record.project) : '';
  record.fields['晨报表code'] = details.record ? valueToText(details.record.code) : '';
  record.fields['晨报表投手'] = details.record ? valueToText(details.record.shooter) : '';
  record.fields['建议以谁为准'] = details.sourceOfTruth || '';
  record.fields['处理建议'] = details.suggestion || '';
  return record;
}

function unmatchedReasonText(reason) {
  if (reason === 'no_candidate') return 'XMP有该行，但晨报/投手表中找不到可匹配记录';
  if (String(reason || '').includes('duplicate')) return '找到多个候选记录，无法自动判断唯一匹配';
  return String(reason || '未匹配');
}

function buildMismatchRecordForTarget(match, normalFields) {
  const sourceRecord = {
    record_id: match.record.recordId,
    fields: match.record.fields,
  };
  return buildTargetRecord(
    sourceRecord,
    normalFields,
    new Map([[match.record.recordId, match]])
  );
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

async function processIncomingRawFile(options) {
  const {
    rawFilePath,
    rawFileName,
    businessDate,
    shooterBaseUrl = config.shooterBaseUrl,
    aiCorrectionBaseUrl = config.aiCorrectionBaseUrl,
    shooterMismatchBaseUrl = config.shooterMismatchBaseUrl,
    crawlFailureBaseUrl = config.crawlFailureBaseUrl,
    unmatchedBaseUrl = config.unmatchedBaseUrl,
    outputRoot = path.join(process.cwd(), 'outputs'),
  } = options;

  if (!rawFilePath || !businessDate || !shooterBaseUrl || !aiCorrectionBaseUrl || !shooterMismatchBaseUrl || !crawlFailureBaseUrl || !unmatchedBaseUrl) {
    throw new Error('缺少 rawFilePath、businessDate、shooterBaseUrl、aiCorrectionBaseUrl、shooterMismatchBaseUrl、crawlFailureBaseUrl 或 unmatchedBaseUrl');
  }

  const feishu = await new FeishuClient().init();
  const dateName = chineseDateName(businessDate);
  const sourceTableName = `${dateName}投手数据`;
  const wantedOutputName = `${dateName}ai修正`;
  const adsRows = feishu.readAdsRowsFromXlsx(rawFilePath);
  const crawlFailedRows = adsRows.filter(isCrawlFailure);
  const usableAdsRows = adsRows.filter((ad) => !isCrawlFailure(ad));
  const source = await feishu.readBitableTableByName(shooterBaseUrl, sourceTableName);
  const crawlFailureMatched = matchAdsToRecords(crawlFailedRows, source.records);
  const crawlFailureRecordIds = new Set(crawlFailureMatched.matches.map((match) => match.record.recordId));
  const matched = matchAdsToRecords(usableAdsRows, source.records);
  const postFailureMatches = matched.matches.filter((match) => !crawlFailureRecordIds.has(match.record.recordId));
  const reviewForManual = matched.review.filter((item) => item.type !== '强清洗匹配');
  const shooterMismatchMatches = postFailureMatches.filter((match) => match.shooterDiff);
  const shooterMismatchRecordIds = new Set(shooterMismatchMatches.map((match) => match.record.recordId));
  const writableMatches = postFailureMatches.filter((match) => !shooterMismatchRecordIds.has(match.record.recordId));
  const writableMatchByRecordId = new Map(writableMatches.map((match) => [match.record.recordId, match]));
  const assignedRecordIds = new Set([
    ...crawlFailureRecordIds,
    ...shooterMismatchRecordIds,
    ...writableMatches.map((match) => match.record.recordId),
  ]);
  const shooterMismatchRows = shooterMismatchMatches.length;
  const shooterUnmatched = source.records.filter((record) => !assignedRecordIds.has(record.recordId));
  const rawRecordById = new Map(source.rawRecords.map((record) => [record.record_id, record]));

  const writableSourceRecords = writableMatches
    .map((match) => rawRecordById.get(match.record.recordId))
    .filter(Boolean);
  const targetRecords = writableSourceRecords.map((record) => buildTargetRecord(record, normalFields(source.fields), writableMatchByRecordId));
  const target = await createTableWithRecords(
    feishu,
    aiCorrectionBaseUrl,
    source,
    wantedOutputName,
    targetRecords
  );

  const mismatchMatchByRecordId = new Map(shooterMismatchMatches.map((match) => [match.record.recordId, match]));
  const mismatchRecords = shooterMismatchMatches
    .map((match) => {
      const record = rawRecordById.get(match.record.recordId);
      if (!record) return null;
      return addReviewFields(
        buildTargetRecord(record, normalFields(source.fields), mismatchMatchByRecordId),
        {
          issueType: '投手不一致',
          reason: 'XMP原始投手与晨报/投手表投手不一致',
          ad: match.ad,
          record: match.record,
          sourceOfTruth: '待人工确认',
          suggestion: '请人工核对实际归属投手；确认后在表内调整投手或指标',
        }
      );
    })
    .filter(Boolean);
  const mismatchTable = shooterMismatchMatches.length
    ? await createReviewTableWithRecords(
      feishu,
      shooterMismatchBaseUrl,
      source,
      `${dateName}投手不一致`,
      mismatchRecords
    )
    : null;

  const crawlFailureMatchBySourceRow = new Map(
    crawlFailureMatched.matches.map((match) => [match.ad.sourceRow, match])
  );
  const crawlFailureRecords = [];
  for (const ad of crawlFailedRows) {
    const match = crawlFailureMatchBySourceRow.get(ad.sourceRow);
    const sourceRecord = match ? rawRecordById.get(match.record.recordId) : null;
    crawlFailureRecords.push(addReviewFields(
      buildAdRecordForTarget(ad, normalFields(source.fields), sourceRecord),
      {
        issueType: '抓取失败',
        reason: match
          ? 'XMP原始数据标记为抓取失败/无数据，但已找到晨报/投手表候选记录'
          : 'XMP原始数据标记为抓取失败/无数据，且晨报/投手表未找到匹配记录',
        ad,
        record: match ? match.record : null,
        sourceOfTruth: '待人工确认',
        suggestion: '优先确认后台/XMP抓取状态；如确有数据，请人工补充',
      }
    ));
  }
  const crawlFailureTable = crawlFailureRecords.length
    ? await createReviewTableWithRecords(
      feishu,
      crawlFailureBaseUrl,
      source,
      `${dateName}抓取失败`,
      crawlFailureRecords
    )
    : null;

  const xmpUnmatchedRecords = matched.unmatched.map(({ ad, reason }) => addReviewFields(
    buildAdRecordForTarget(ad, normalFields(source.fields), null),
    {
      issueType: 'XMP有，晨报/投手表未匹配',
      reason: unmatchedReasonText(reason),
      ad,
      record: null,
      sourceOfTruth: 'XMP原始数据',
      suggestion: '请确认晨报/投手表是否缺项目、缺code或命名不一致；必要时补维护表',
    }
  ));
  const shooterUnmatchedRecords = shooterUnmatched
    .map((record) => {
      const rawRecord = rawRecordById.get(record.recordId);
      if (!rawRecord) return null;
      return addReviewFields(
        buildTargetRecord(rawRecord, normalFields(source.fields), new Map()),
        {
          issueType: '晨报/投手表有，XMP未匹配',
          reason: '晨报/投手表有该记录，但XMP原始数据中没有匹配行',
          ad: null,
          record,
          sourceOfTruth: '晨报/投手表',
          suggestion: '请确认XMP是否漏抓、项目是否停投、code/国家/KPI是否维护错误',
        }
      );
    })
    .filter(Boolean);
  const allUnmatchedRecords = [...xmpUnmatchedRecords, ...shooterUnmatchedRecords];
  const unmatchedTable = allUnmatchedRecords.length
    ? await createReviewTableWithRecords(
      feishu,
      unmatchedBaseUrl,
      source,
      `${dateName}未匹配`,
      allUnmatchedRecords
    )
    : null;

  const outputDir = path.join(outputRoot, safeName(target.tableName));
  const unmatchedPath = path.join(outputDir, '未匹配清单.csv');
  const reviewPath = path.join(outputDir, '待人工确认清单.csv');
  const shooterUnmatchedPath = path.join(outputDir, '投手未匹配清单.csv');
  const summaryPath = path.join(outputDir, '处理结果摘要.json');
  const targetUrl = target.url;

  writeCsv(unmatchedPath, reportUnmatchedRows(matched.unmatched));
  writeCsv(reviewPath, reportReviewRows(reviewForManual));
  writeCsv(shooterUnmatchedPath, reportShooterUnmatchedRows(shooterUnmatched));

  const summary = {
    rawFileName,
    rawFilePath,
    businessDate,
    shooterBaseUrl,
    aiCorrectionBaseUrl,
    shooterMismatchBaseUrl,
    crawlFailureBaseUrl,
    unmatchedBaseUrl,
    sourceTableName,
    sourceTableId: source.table.table_id,
    outputName: target.tableName,
    targetUrl,
    targetAppToken: target.appToken,
    targetTableName: target.tableName,
    targetTableId: target.tableId,
    adsRows: adsRows.length,
    usableAdsRows: usableAdsRows.length,
    crawlFailureRows: crawlFailedRows.length,
    sourceRows: source.records.length,
    targetRows: target.rows,
    matchedRows: matched.matches.length,
    writtenRows: writableMatches.length,
    shooterMismatchRows,
    mismatchTable,
    crawlFailureTable,
    unmatchedTable,
    unmatchedRows: matched.unmatched.length,
    reviewRows: reviewForManual.length,
    shooterUnmatchedRows: shooterUnmatched.length,
    fieldReplica: {
      mode: 'create_table_pages_inside_fixed_result_bases',
      note: '结果表通过复制当天投手多维表格生成，以保留字段、公式、视图和分组',
      total: source.fields.length,
      formulas: target.formulaFields.length,
    },
    matchStrategies: countBy(matched.matches, (item) => item.strategy),
    reviewTypes: countBy(reviewForManual, (item) => item.type),
    unmatchedPath,
    reviewPath,
    shooterUnmatchedPath,
    summaryPath,
    createdAt: new Date().toISOString(),
  };
  writeJson(summaryPath, summary);
  return summary;
}

module.exports = {
  processIncomingRawFile,
  chineseDateName,
};
