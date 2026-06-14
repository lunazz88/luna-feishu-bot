const fs = require('fs');
const path = require('path');
const { FeishuClient } = require('./feishuClient');
const { matchAdsToRecords, valueToText } = require('./matcher');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const eqIndex = current.indexOf('=');
    if (eqIndex >= 0) {
      args[current.slice(2, eqIndex)] = current.slice(eqIndex + 1);
    } else {
      const key = current.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

function usage() {
  return `
Usage:
  node src/processDailyData.js --rawUrl="<wiki/sheet url>" --shooterUrl="<base url>" --name="六月八号数据修正" [--execute]

Default mode is dry-run:
  - Reads raw ads table and shooter table
  - Runs matching
  - Writes local reports only

With --execute:
  - Copies shooter bitable
  - Writes matched metrics only into copied bitable
  - Opens tenant editable link permission
`;
}

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

function metricValue(value) {
  return value == null ? '' : value;
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
      metricValue(ad.metrics.spend),
      metricValue(ad.metrics.impressions),
      metricValue(ad.metrics.clicks),
      metricValue(ad.metrics.registrations),
      metricValue(ad.metrics.firstDeposits),
      reason,
    ]),
  ];
}

function reportReviewRows(review) {
  return [
    ['类型', '原始项目', '原始code', '原始投手', '国家', 'KPI', '副本项目', '副本code', '副本投手', '匹配策略'],
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

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function validateRequiredFields(fields) {
  const fieldNames = new Set(fields.map((field) => field.field_name));
  const required = ['项目', 'Code', '投手', '国家', '花费金额', '展示次数', '点击量', '注册人数', '首存人数'];
  const missing = required.filter((field) => !fieldNames.has(field));
  if (missing.length) throw new Error(`Target table missing required fields: ${missing.join(', ')}`);
}

async function processDailyData(options) {
  const {
    rawUrl,
    shooterUrl,
    name,
    execute = false,
    targetUrl,
    outputRoot = path.join(process.cwd(), 'outputs'),
  } = options;

  if (!rawUrl || !shooterUrl || !name) {
    throw new Error('Missing required args: --rawUrl, --shooterUrl, --name');
  }

  const outputDir = path.join(outputRoot, safeName(name));
  ensureDir(outputDir);

  const feishu = await new FeishuClient().init();
  const adsRows = await feishu.readAdsRows(rawUrl);
  const source = await feishu.readFirstBitable(shooterUrl);

  let target = source;
  let copied = null;
  let permissionResult = null;
  let ownerGrantResult = null;

  if (execute && targetUrl) {
    target = await feishu.readFirstBitable(targetUrl);
    copied = {
      copiedAppToken: target.appToken,
      copiedUrl: targetUrl,
      reusedExisting: true,
    };
    permissionResult = await feishu.setTenantEditable(target.appToken);
    ownerGrantResult = await feishu.grantSourceOwnerEdit(shooterUrl, target.appToken);
  } else if (execute) {
    copied = await feishu.copyBitable(shooterUrl, name);
    permissionResult = await feishu.setTenantEditable(copied.copiedAppToken);
    ownerGrantResult = await feishu.grantSourceOwnerEdit(shooterUrl, copied.copiedAppToken);
    target = await feishu.readFirstBitable(copied.copiedUrl);
  }

  validateRequiredFields(target.fields);

  const matched = matchAdsToRecords(adsRows, target.records);
  const updates = matched.matches.map((match) => feishu.buildMetricUpdate(match));

  if (execute) {
    await feishu.batchUpdateRecords(target.appToken, target.table.table_id, updates);
  }

  const unmatchedPath = path.join(outputDir, '未匹配清单.csv');
  const reviewPath = path.join(outputDir, '待人工确认清单.csv');
  const summaryPath = path.join(outputDir, '处理结果摘要.json');

  writeCsv(unmatchedPath, reportUnmatchedRows(matched.unmatched));
  writeCsv(reviewPath, reportReviewRows(matched.review));

  const summary = {
    dryRun: !execute,
    rawUrl,
    shooterUrl,
    outputName: name,
    sourceAppToken: source.appToken,
    targetAppToken: target.appToken,
    targetUrl: copied ? copied.copiedUrl : shooterUrl,
    copied,
    permissionResult,
    ownerGrantResult,
    sourceTable: {
      table_id: source.table.table_id,
      name: source.table.name,
      fieldCount: source.fields.length,
      records: source.records.length,
    },
    targetTable: {
      table_id: target.table.table_id,
      name: target.table.name,
      fieldCount: target.fields.length,
      records: target.records.length,
    },
    adsRows: adsRows.length,
    matchedRows: matched.matches.length,
    plannedUpdates: updates.length,
    writtenRows: execute ? updates.length : 0,
    unmatchedRows: matched.unmatched.length,
    reviewRows: matched.review.length,
    matchStrategies: countBy(matched.matches, (item) => item.strategy),
    reviewTypes: countBy(matched.review, (item) => item.type),
    unmatchedPath,
    reviewPath,
    summaryPath,
    createdAt: new Date().toISOString(),
  };

  writeJson(summaryPath, summary);
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  const summary = await processDailyData({
    rawUrl: args.rawUrl,
    shooterUrl: args.shooterUrl,
    name: args.name,
    execute: Boolean(args.execute),
    targetUrl: args.targetUrl,
    outputRoot: args.outputRoot,
  });
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    const details = error.details || {
      message: error.message,
      stack: error.stack,
    };
    console.log(JSON.stringify(details, null, 2));
    process.exitCode = 1;
  });
}

module.exports = {
  processDailyData,
};
