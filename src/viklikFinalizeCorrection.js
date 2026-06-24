const fs = require('fs');
const path = require('path');
const { config, configFromEnvFile } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { normalizeCommon, valueToNumber, valueToText } = require('./matcher');

const cacheRoot = path.join(process.cwd(), 'outputs', 'viklik-xmp');
const reviewAppRegistryPath = path.join(cacheRoot, 'review-app-registry.json');
const fileRegistryPath = path.join(cacheRoot, 'xmp-file-registry.json');

const METRIC_FIELDS = ['花费金额', '展示次数', '点击量', '注册人数', '首存人数'];

function paddedDateLabel(dateText) {
  const [, month, day] = String(dateText).match(/^20\d{2}-(\d{2})-(\d{2})$/) || [];
  if (!month || !day) return dateText;
  return `${month}.${day}`;
}

function tableUrlFromAppToken(baseUrl, appToken, tableId) {
  const domain = new URL(baseUrl).hostname;
  return `https://${domain}/base/${appToken}?table=${tableId}`;
}

function targetMatchTableName(businessDate) {
  return `${paddedDateLabel(businessDate)}-ai匹配表`;
}

function loadReviewAppRegistry() {
  if (!fs.existsSync(reviewAppRegistryPath)) return { appsByDate: {} };
  return JSON.parse(fs.readFileSync(reviewAppRegistryPath, 'utf8'));
}

function loadFileRegistry() {
  if (!fs.existsSync(fileRegistryPath)) return { filesByDate: {} };
  return JSON.parse(fs.readFileSync(fileRegistryPath, 'utf8'));
}

function latestFileForDate(businessDate) {
  const registry = loadFileRegistry();
  const entries = registry.filesByDate[businessDate] || [];
  return entries.find((entry) => entry.outputPath && fs.existsSync(entry.outputPath)) || null;
}

function cents(value) {
  const number = valueToNumber(value);
  return number == null ? 0 : Math.round(number * 100);
}

function formatMoneyFromCents(value) {
  return (value / 100).toFixed(2);
}

function reviewRowToNormalized(row) {
  const fields = row.fields || {};
  return normalizeCommon({
    recordId: row.record_id,
    sourceRow: valueToNumber(fields['XMP行号']),
    targetPosition: valueToNumber(fields['晨报行号']),
    status: valueToText(fields['处理状态']),
    type: valueToText(fields['问题类型']),
    project: valueToText(fields['项目']),
    code: valueToText(fields.code || fields.Code || fields['Code']),
    shooter: valueToText(fields['晨报投手'] || fields['XMP投手']),
    country: valueToText(fields['国家']),
    metrics: {
      spend: valueToNumber(fields['花费金额']),
      impressions: valueToNumber(fields['展示次数']),
      clicks: valueToNumber(fields['点击量']),
      registrations: valueToNumber(fields['注册人数']),
      firstDeposits: valueToNumber(fields['首存人数']),
    },
  });
}

function targetRecordToNormalized(record, index) {
  const fields = record.fields || {};
  return normalizeCommon({
    recordId: record.record_id,
    position: index + 1,
    fields,
    project: valueToText(fields['项目'] || fields['项目名称']),
    code: valueToText(fields.Code || fields.code || fields.CODE),
    shooter: valueToText(fields['投手']),
    country: valueToText(fields['国家']),
  });
}

function matchKey(row) {
  return [row.projectNorm, row.codeStrong, row.shooterNorm].join('\u0001');
}

function metricUpdates(row) {
  const updates = {};
  const pairs = [
    ['花费金额', row.metrics.spend],
    ['展示次数', row.metrics.impressions],
    ['点击量', row.metrics.clicks],
    ['注册人数', row.metrics.registrations],
    ['首存人数', row.metrics.firstDeposits],
  ];
  for (const [field, value] of pairs) {
    if (value !== null && value !== undefined) updates[field] = value;
  }
  return updates;
}

function hasMetrics(updates) {
  return METRIC_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(updates, field));
}

function targetSpendTotalCents(records) {
  return records.reduce((total, record) => total + cents((record.fields || {})['花费金额']), 0);
}

function xmpSpendTotalCents(feishu, businessDate) {
  const fileEntry = latestFileForDate(businessDate);
  if (!fileEntry) return { checked: false, reason: '未找到当天 XMP 原始文件缓存' };
  const rows = feishu.readAdsRowsFromXlsx(fileEntry.outputPath);
  const total = rows.reduce((sum, row) => sum + cents(row.metrics && row.metrics.spend), 0);
  return {
    checked: true,
    total,
    fileName: fileEntry.fileName,
    rows: rows.length,
  };
}

async function readReviewRows(feishu, reviewAppToken) {
  const tables = await feishu.listTables(reviewAppToken);
  const wanted = ['抓取失败', '投手不一致', 'XMP有晨报没有', '晨报有XMP没有'];
  const rows = [];
  for (const tableName of wanted) {
    const table = tables.find((item) => item.name === tableName);
    if (!table) continue;
    const rawRecords = await feishu.listRecords(reviewAppToken, table.table_id);
    for (const rawRecord of rawRecords) {
      rows.push({
        tableName,
        row: reviewRowToNormalized(rawRecord),
      });
    }
  }
  return rows;
}

async function finalizeViklikAiMatch(options = {}) {
  const businessDate = options.businessDate;
  if (!businessDate) throw new Error('没有识别到日期，请发送类似：更新06.23数据');

  const docConfig = options.docConfig
    || (process.env.FEISHU_DOC_ENV_PATH ? configFromEnvFile(process.env.FEISHU_DOC_ENV_PATH) : config);
  const feishu = options.feishu || await new FeishuClient(docConfig).init();
  const appToken = await feishu.resolveBitableAppToken(docConfig.shooterBaseUrl);
  const tables = await feishu.listTables(appToken);
  const targetTableName = targetMatchTableName(businessDate);
  const targetTable = tables.find((table) => table.name === targetTableName);
  if (!targetTable) throw new Error(`未找到 ${targetTableName}，请先运行第一个机器人生成 ai匹配表`);

  const registry = loadReviewAppRegistry();
  const reviewApp = registry.appsByDate[businessDate];
  if (!reviewApp || !reviewApp.appToken) throw new Error(`未找到 ${paddedDateLabel(businessDate)} 的核对表记录，请先运行第一个机器人`);

  const targetRawRecords = await feishu.listRecords(appToken, targetTable.table_id);
  const targetRows = targetRawRecords.map(targetRecordToNormalized);
  const byPosition = new Map(targetRows.map((row) => [row.position, row]));
  const byKey = new Map();
  for (const row of targetRows) {
    const key = matchKey(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const reviewRows = await readReviewRows(feishu, reviewApp.appToken);
  const updatesByRecordId = new Map();
  const skipped = [];
  const shooterMismatchManual = {
    rowsWithMetrics: 0,
    updatedRows: 0,
  };

  for (const item of reviewRows) {
    const row = item.row;
    const updates = metricUpdates(row);
    if (!hasMetrics(updates)) {
      skipped.push({ tableName: item.tableName, reason: '没有填写可回写的数值' });
      continue;
    }
    if (item.tableName === '投手不一致') shooterMismatchManual.rowsWithMetrics += 1;

    let target = row.targetPosition ? byPosition.get(row.targetPosition) : null;
    if (!target) {
      const candidates = byKey.get(matchKey(row)) || [];
      if (candidates.length === 1) target = candidates[0];
      if (candidates.length > 1) {
        skipped.push({ tableName: item.tableName, reason: '找到多条目标候选，无法自动判断' });
        continue;
      }
    }
    if (!target) {
      skipped.push({ tableName: item.tableName, reason: '未找到可回写的 ai匹配表行' });
      continue;
    }

    updatesByRecordId.set(target.recordId, {
      ...(updatesByRecordId.get(target.recordId) || {}),
      ...updates,
    });
    if (item.tableName === '投手不一致') shooterMismatchManual.updatedRows += 1;
  }

  const updates = [...updatesByRecordId.entries()].map(([recordId, fields]) => ({
    record_id: recordId,
    fields,
  }));
  await feishu.batchUpdateRecords(appToken, targetTable.table_id, updates);
  const updatedTargetRecords = await feishu.listRecords(appToken, targetTable.table_id);
  const targetSpend = targetSpendTotalCents(updatedTargetRecords);
  const xmpSpend = xmpSpendTotalCents(feishu, businessDate);
  const spendCheck = xmpSpend.checked
    ? {
      checked: true,
      xmpTotal: xmpSpend.total,
      targetTotal: targetSpend,
      diff: targetSpend - xmpSpend.total,
      ok: targetSpend === xmpSpend.total,
      fileName: xmpSpend.fileName,
      xmpRows: xmpSpend.rows,
    }
    : {
      checked: false,
      targetTotal: targetSpend,
      reason: xmpSpend.reason,
    };

  return {
    businessDate,
    targetTableName,
    targetUrl: tableUrlFromAppToken(docConfig.shooterBaseUrl, appToken, targetTable.table_id),
    reviewAppName: reviewApp.name,
    reviewAppUrl: reviewApp.url,
    reviewRows: reviewRows.length,
    updatedRows: updates.length,
    skippedRows: skipped.length,
    shooterMismatchManual,
    spendCheck,
    skipped,
  };
}

function formatViklikFinalSummary(result) {
  const spendLine = result.spendCheck.checked
    ? `花费校验：${result.spendCheck.ok ? '一致' : '不一致'}（XMP ${formatMoneyFromCents(result.spendCheck.xmpTotal)} / ai匹配表 ${formatMoneyFromCents(result.spendCheck.targetTotal)} / 差额 ${formatMoneyFromCents(result.spendCheck.diff)}）`
    : `花费校验：未完成（${result.spendCheck.reason}，ai匹配表 ${formatMoneyFromCents(result.spendCheck.targetTotal)}）`;
  const shooterMismatchLine = result.shooterMismatchManual.rowsWithMetrics
    ? `投手需人工修改：${result.shooterMismatchManual.rowsWithMetrics} 条（其中已回填数值 ${result.shooterMismatchManual.updatedRows} 条，投手字段未自动改）`
    : '投手需人工修改：0 条';
  return [
    `更新完成：${result.targetTableName}`,
    `回写成功：${result.updatedRows} 条`,
    `跳过：${result.skippedRows} 条`,
    shooterMismatchLine,
    spendLine,
    result.targetUrl,
    '',
    `核对表：${result.reviewAppName}`,
    result.reviewAppUrl,
  ].join('\n');
}

module.exports = {
  finalizeViklikAiMatch,
  formatViklikFinalSummary,
};
