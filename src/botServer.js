const http = require('http');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const { parseCommand, commandHelp } = require('./parseCommand');
const { processDailyData } = require('./processDailyData');

const PORT = Number(process.env.BOT_PORT || 8787);
const processedEventIds = new Set();

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function textResponse(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return null;
  }
}

function parseMessageText(message) {
  if (!message) return '';
  if (message.message_type !== 'text') return '';
  const content = safeJsonParse(message.content);
  return content && content.text ? content.text : '';
}

function isUrlVerification(payload) {
  return Boolean(
    payload &&
      (payload.type === 'url_verification' ||
        payload.challenge ||
        (payload.header && payload.header.event_type === 'url_verification') ||
        (payload.event && (payload.event.type === 'url_verification' || payload.event.challenge)))
  );
}

function getChallenge(payload) {
  return payload.challenge || (payload.event && payload.event.challenge) || '';
}

function eventId(payload) {
  return payload && payload.header && payload.header.event_id;
}

function isMessageEvent(payload) {
  return payload && payload.header && payload.header.event_type === 'im.message.receive_v1';
}

function shouldIgnoreEvent(payload) {
  const id = eventId(payload);
  if (!id) return false;
  if (processedEventIds.has(id)) return true;
  processedEventIds.add(id);
  if (processedEventIds.size > 5000) processedEventIds.clear();
  return false;
}

function verifyToken(payload) {
  if (!config.verificationToken) return true;
  if (payload.token && payload.token !== config.verificationToken) return false;
  if (payload.header && payload.header.token && payload.header.token !== config.verificationToken) return false;
  return true;
}

async function reply(messageId, text) {
  if (!messageId) return;
  try {
    const feishu = await new FeishuClient().init();
    await feishu.replyText(messageId, text);
  } catch (error) {
    console.log(JSON.stringify(error.details || { message: error.message }, null, 2));
  }
}

async function handleMessage(payload) {
  const message = payload.event && payload.event.message;
  const messageId = message && message.message_id;
  const text = parseMessageText(message);

  if (!text || /^(help|帮助)$/i.test(text.trim())) {
    await reply(messageId, commandHelp());
    return;
  }

  const command = parseCommand(text);
  if (command.errors.length) {
    await reply(messageId, `${command.errors.join('\n')}\n\n${commandHelp()}`);
    return;
  }

  await reply(messageId, `收到，开始处理：${command.name}\n我会复制投手表并只写入新副本。`);

  try {
    const summary = await processDailyData({
      rawUrl: command.rawUrl,
      shooterUrl: command.shooterUrl,
      name: command.name,
      execute: true,
    });

    await reply(
      messageId,
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
    await reply(messageId, `处理失败：${details.msg || details.message || '未知错误'}\n请检查链接权限或稍后重试。`);
  }
}

async function handleEvent(req, res) {
  const raw = await readBody(req);
  const payload = safeJsonParse(raw);
  if (!payload) {
    jsonResponse(res, 400, { error: 'invalid json' });
    return;
  }

  if (!verifyToken(payload)) {
    jsonResponse(res, 403, { error: 'verification token mismatch' });
    return;
  }

  if (isUrlVerification(payload)) {
    jsonResponse(res, 200, { challenge: getChallenge(payload) });
    return;
  }

  jsonResponse(res, 200, { code: 0 });

  if (shouldIgnoreEvent(payload)) return;
  if (isMessageEvent(payload)) {
    handleMessage(payload).catch((error) => {
      console.log(JSON.stringify(error.details || { message: error.message, stack: error.stack }, null, 2));
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    textResponse(res, 200, 'ok');
    return;
  }
  if (req.method === 'POST' && req.url === '/feishu/events') {
    handleEvent(req, res).catch((error) => {
      console.log(error.stack || error.message);
      jsonResponse(res, 500, { error: 'internal error' });
    });
    return;
  }
  jsonResponse(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Feishu bot server listening on http://127.0.0.1:${PORT}`);
  console.log(`Event callback path: /feishu/events`);
});
