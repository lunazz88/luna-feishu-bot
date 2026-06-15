const fs = require('fs');
const path = require('path');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { parseCommand, commandHelp } = require('./parseCommand');
const { processDailyData } = require('./processDailyData');
const { processIncomingRawFile } = require('./processIncomingRawFile');
const { isFinalUpdateCommand } = require('./finalizeDailyCorrection');

const Lark = require(path.join(config.nodeModulesDir, '@larksuiteoapi/node-sdk'));

const processedMessageIds = new Set();
const incomingRoot = path.join(process.cwd(), 'outputs', 'incoming');
const incomingRetentionDays = Number(process.env.FEISHU_INCOMING_RETENTION_DAYS || 7);
const incomingRetentionMs = incomingRetentionDays * 24 * 60 * 60 * 1000;

function parseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function parseMessageText(message) {
  if (!message || message.message_type !== 'text') return '';
  return parseJson(message.content).text || '';
}

function safeName(name) {
  return String(name || 'file')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_');
}

function localDateFromTimestamp(msText) {
  const ms = Number(msText);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractDate(fileName, fallbackDate) {
  const text = String(fileName || '');
  const yyyyMMdd = text.match(/(20\d{2})[-_.年](\d{1,2})[-_.月](\d{1,2})/);
  if (yyyyMMdd) {
    return `${yyyyMMdd[1]}-${yyyyMMdd[2].padStart(2, '0')}-${yyyyMMdd[3].padStart(2, '0')}`;
  }
  const mmdd = text.match(/(?:^|[^\d])(\d{1,2})[._月-](\d{1,2})(?:[^\d]|$)/);
  if (mmdd) {
    const year = fallbackDate.slice(0, 4);
    return `${year}-${mmdd[1].padStart(2, '0')}-${mmdd[2].padStart(2, '0')}`;
  }
  return fallbackDate;
}

function classifyFile(fileName) {
  const text = String(fileName || '').toLowerCase();
  if (/crawler|xmp|广告|原始/.test(text)) return 'raw_ads';
  if (/所有项目|项目数据更新|晨会|投手/.test(text)) return 'shooter_filled';
  return 'unknown';
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

function writeInboxState(entry) {
  fs.mkdirSync(incomingRoot, { recursive: true });
  const statePath = path.join(incomingRoot, 'state.jsonl');
  fs.appendFileSync(statePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function cleanupIncomingFiles(now = Date.now()) {
  if (!fs.existsSync(incomingRoot)) return { deletedFiles: 0, deletedDirs: 0 };

  let deletedFiles = 0;
  let deletedDirs = 0;
  const cutoff = now - incomingRetentionMs;
  const excelPattern = /\.(xlsx|xls|csv)$/i;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        if (fullPath !== incomingRoot && fs.readdirSync(fullPath).length === 0) {
          fs.rmdirSync(fullPath);
          deletedDirs += 1;
        }
        continue;
      }

      if (!entry.isFile() || !excelPattern.test(entry.name)) continue;
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(fullPath);
        deletedFiles += 1;
      }
    }
  }

  walk(incomingRoot);
  return { deletedFiles, deletedDirs };
}

async function reply(messageId, text) {
  const feishu = await new FeishuClient().init();
  await feishu.replyText(messageId, text);
}

async function sendResultText(sourceMessageId, text) {
  const feishu = await new FeishuClient().init();
  if (config.resultChatId) {
    await feishu.sendTextToChat(config.resultChatId, text);
    return;
  }
  await feishu.replyText(sourceMessageId, text);
}

async function handleFileMessage(message, summary) {
  const cleanup = cleanupIncomingFiles();
  if (cleanup.deletedFiles || cleanup.deletedDirs) {
    console.log(JSON.stringify({ event: 'incoming_cleanup', ...cleanup }));
  }

  const fileKey = summary.fileKey;
  const fileName = summary.fileName || `${summary.messageId}.xlsx`;
  const fallbackDate = localDateFromTimestamp(summary.createTime);
  const businessDate = extractDate(fileName, fallbackDate);
  const fileType = classifyFile(fileName);
  const outputDir = path.join(incomingRoot, businessDate);
  const outputPath = path.join(outputDir, `${summary.messageId}-${safeName(fileName)}`);

  if (!fileKey) {
    await reply(message.message_id, '收到文件消息，但没有识别到 file_key。请把这条消息截图给我看一下。');
    return;
  }

  const feishu = await new FeishuClient().init();
  const downloaded = await feishu.downloadMessageResourceToFile(
    summary.messageId,
    fileKey,
    outputPath,
    'file'
  );

  const entry = {
    receivedAt: new Date().toISOString(),
    chatId: summary.chatId,
    messageId: summary.messageId,
    fileKey,
    fileName,
    businessDate,
    fileType,
    outputPath: downloaded.outputPath,
    bytes: downloaded.bytes,
  };
  writeInboxState(entry);

  const typeText = {
    raw_ads: 'XMP 原始广告数据',
    shooter_filled: '投手填写数据',
    unknown: '未知类型',
  }[fileType];

  if (fileType === 'raw_ads') {
    await reply(
      message.message_id,
      [
        `已下载原始广告文件：${fileName}`,
        `识别日期：${businessDate}`,
        '开始查找同日期投手数据，并生成 ai 修正表...',
      ].join('\n')
    );

    const result = await processIncomingRawFile({
      rawFilePath: downloaded.outputPath,
      rawFileName: fileName,
      businessDate,
    });

    await sendResultText(
      message.message_id,
      [
        `处理完成：${result.targetTableName}`,
        '',
        `原始表：${result.adsRows} 条`,
        `投手表：${result.sourceRows} 条`,
        '',
        `AI修正表：${result.targetRows} 条`,
        `AI修正表链接：${result.targetUrl}`,
        '',
        `抓取失败表：${result.crawlFailureTable ? result.crawlFailureTable.rows : 0} 条`,
        result.crawlFailureTable ? `抓取失败表链接：${result.crawlFailureTable.url}` : '抓取失败表：无记录，未新建',
        '',
        `投手不一致表：${result.mismatchTable ? result.mismatchTable.rows : 0} 条`,
        result.mismatchTable ? `投手不一致表：${result.mismatchTable.url}` : '投手不一致表：无记录，未新建',
        '',
        `未匹配表：${result.unmatchedTable ? result.unmatchedTable.rows : 0} 条`,
        result.unmatchedTable ? `未匹配表链接：${result.unmatchedTable.url}` : '未匹配表：无记录，未新建',
      ].join('\n')
    );

    return;
  }

  await reply(
    message.message_id,
    [
      `已下载文件：${fileName}`,
      `识别类型：${typeText}`,
      `识别日期：${businessDate}`,
      `本地路径：${downloaded.outputPath}`,
      '',
      fileType === 'raw_ads'
        ? '下一步会用这个原始文件，去找同日期的投手多维表格并生成修正表。'
        : '这个文件已入库，后面可以作为投手数据来源参与匹配。',
    ].join('\n')
  );
}

async function handleTextMessage(message, text) {
  if (isFinalUpdateCommand(text)) return;

  if (!text || /^(help|帮助)$/i.test(text.trim())) {
    await reply(message.message_id, commandHelp());
    return;
  }

  const command = parseCommand(text);
  if (command.errors.length) {
    await reply(message.message_id, `${command.errors.join('\n')}\n\n${commandHelp()}`);
    return;
  }

  await reply(message.message_id, `收到，开始处理：${command.name}\n我会复制投手表，并只写入新副本。`);

  try {
    const summary = await processDailyData({
      rawUrl: command.rawUrl,
      shooterUrl: command.shooterUrl,
      name: command.name,
      execute: true,
    });

    await reply(
      message.message_id,
      [
        `处理完成：${command.name}`,
        summary.targetUrl,
        '',
        `原始数据：${summary.adsRows} 行`,
        `修正表记录：${summary.targetTable.records} 条`,
        `成功写入：${summary.writtenRows} 条`,
        `未匹配：${summary.unmatchedRows} 条`,
        `待人工确认：${summary.reviewRows} 条`,
      ].join('\n')
    );
  } catch (error) {
    const details = error.details || { message: error.message };
    console.log(JSON.stringify(details, null, 2));
    await reply(message.message_id, `处理失败：${details.msg || details.message || '未知错误'}\n请检查链接权限或稍后重试。`);
  }
}

async function handleMessage(data) {
  const message = data && data.message;
  if (!message || !message.message_id) return;

  if (processedMessageIds.has(message.message_id)) return;
  processedMessageIds.add(message.message_id);
  if (processedMessageIds.size > 5000) processedMessageIds.clear();

  const text = parseMessageText(message);
  const summary = summarizeMessage(message);
  console.log(JSON.stringify({ event: 'message', ...summary, text }, null, 2));

  try {
    if (message.message_type === 'file') {
      await handleFileMessage(message, summary);
      return;
    }

    if (message.message_type !== 'text') {
      await reply(
        message.message_id,
        [
          `已收到 ${message.message_type} 消息。`,
          `chat_id: ${message.chat_id}`,
          `file_key: ${summary.fileKey || '未识别'}`,
          `file_name: ${summary.fileName || '未识别'}`,
        ].join('\n')
      );
      return;
    }

    await handleTextMessage(message, text);
  } catch (error) {
    const details = error.details || { message: error.message };
    console.log(JSON.stringify(details, null, 2));
    await reply(message.message_id, `处理这条消息失败：${details.msg || details.message || '未知错误'}`);
  }
}

async function main() {
  const cleanup = cleanupIncomingFiles();
  if (cleanup.deletedFiles || cleanup.deletedDirs) {
    console.log(JSON.stringify({ event: 'incoming_cleanup', ...cleanup }));
  }

  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    domain: Lark.Domain.Lark,
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
  });

  const wsClient = new Lark.WSClient(baseConfig);
  wsClient.start({ eventDispatcher: dispatcher });

  console.log('Lark WS bot client started. It can receive text and file messages.');
}

main().catch((error) => {
  console.log(error.stack || error.message);
  process.exitCode = 1;
});
