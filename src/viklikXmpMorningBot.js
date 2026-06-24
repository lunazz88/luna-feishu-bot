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
  uniqueTableName,
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

function exactMatchKey(row) {
  return [row.projectNorm, row.codeStrong, row.shooterNorm].join('\u0001');
}

function exactMatchAdsToRecords(adsRows, records) {
  const recordIndex = new Map();
  for (const record of records) {
    const key = exactMatchKey(record);
    if (!key.replace(/\u0001/g, '')) continue;
    if (!recordIndex.has(key)) recordIndex.set(key, []);
    recordIndex.get(key).push(record);
  }

  const matches = [];
  const unmatched = [];
  const duplicateRecords = [];
  for (const ad of adsRows) {
    const key = exactMatchKey(ad);
    const candidates = recordIndex.get(key) || [];
    if (candidates.length === 1) {
      matches.push({ ad, record: candidates[0], strategy: 'project+code+shooter' });
    } else if (candidates.length > 1) {
      duplicateRecords.push({ ad, candidates, reason: '投手表存在多条相同 项目+code+投手' });
    } else {
      unmatched.push({ ad, reason: '未找到相同 项目+code+投手' });
    }
  }
  return { matches, unmatched, duplicateRecords };
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

function fieldIdMapByName(sourceFields, targetFields) {
  const targetByName = new Map(targetFields.map((field) => [field.field_name, field]));
  const out = {};
  for (const sourceField of sourceFields) {
    const targetField = targetByName.get(sourceField.field_name);
    if (targetField) out[sourceField.field_id] = targetField.field_id;
  }
  return out;
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

async function createAiMatchTable({ feishu, baseUrl, businessDate, xmpFilePath }) {
  const appToken = await feishu.resolveBitableAppToken(baseUrl);
  const source = await findShooterSource(feishu, appToken, baseUrl, businessDate);
  const viewTemplate = source;
  const sourceViews = await sourceViewsWithProperty(feishu, appToken, viewTemplate.table.table_id);
  const adsRows = readAdsRows(feishu, xmpFilePath);
  const matched = exactMatchAdsToRecords(adsRows, source.records);
  const rawRecordById = new Map(source.rawRecords.map((record) => [record.record_id, record]));
  const matchByRecordId = new Map(matched.matches.map((match) => [match.record.recordId, match]));
  const tables = await feishu.listTables(appToken);
  const wantedName = `${dateLabel(businessDate)}-ai匹配表`;
  const tableName = uniqueTableName(tables, wantedName);
  const target = await createCorrectionTable(
    feishu,
    appToken,
    source,
    tableName,
    { viewNames: sourceViews.map((view) => view.view_name).filter(Boolean) }
  );
  const targetFields = await feishu.listFields(appToken, target.table_id);
  const viewReplica = await replicateSourceViews(
    feishu,
    appToken,
    target.table_id,
    sourceViews,
    fieldIdMapByName(viewTemplate.fields, targetFields)
  );

  const targetRecords = matched.matches
    .map((match) => rawRecordById.get(match.record.recordId))
    .filter(Boolean)
    .map((record) => buildTargetRecord(record, normalFields(source.fields), matchByRecordId));
  await feishu.batchCreateRecords(appToken, target.table_id, targetRecords);

  return {
    appToken,
    sourceTableName: source.table.name,
    sourceTableId: source.table.table_id,
    targetTableName: tableName,
    targetTableId: target.table_id,
    targetUrl: tableUrlFromAppToken(baseUrl, appToken, target.table_id),
    viewTemplateName: viewTemplate.table.name,
    viewReplica,
    adsRows: adsRows.length,
    sourceRows: source.records.length,
    matchedRows: matched.matches.length,
    writtenRows: targetRecords.length,
    unmatchedRows: matched.unmatched.length,
    duplicateRows: matched.duplicateRecords.length,
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
    const result = await createAiMatchTable({
      feishu,
      baseUrl: config.shooterBaseUrl,
      businessDate,
      xmpFilePath: fileEntry.outputPath,
    });
    await reply(
      message.message_id,
      [
        `处理完成：${result.targetTableName}`,
        `投手表：${result.sourceTableName}`,
        `XMP数据：${result.adsRows} 条`,
        `投手表：${result.sourceRows} 条`,
        `匹配成功：${result.matchedRows} 条`,
        `写入新表：${result.writtenRows} 条`,
        `未匹配：${result.unmatchedRows} 条`,
        `重复候选：${result.duplicateRows} 条`,
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
