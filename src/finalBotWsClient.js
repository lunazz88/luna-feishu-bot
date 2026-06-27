const path = require('path');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const {
  finalizeDailyCorrection,
  formatFinalSummary,
  isFinalUpdateCommand,
  parseBusinessDate,
} = require('./finalizeDailyCorrection');
const {
  finalizeViklikAiMatch,
  formatViklikFinalSummary,
} = require('./viklikFinalizeCorrection');
const { claimFinalCommand } = require('./finalCommandState');

const Lark = require(path.join(config.nodeModulesDir, '@larksuiteoapi/node-sdk'));

const processedMessageIds = new Set();

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

function mentionNamesFromMessage(message) {
  const content = parseJson(message.content || (message.body && message.body.content));
  const mentions = [
    ...(Array.isArray(message.mentions) ? message.mentions : []),
    ...(Array.isArray(content.mentions) ? content.mentions : []),
  ];
  return mentions
    .map((mention) => String(mention.name || mention.text || mention.key || ''))
    .filter(Boolean);
}

function hasBotMention(message, text, names) {
  const expected = names.map((name) => name.toLowerCase());
  const textValue = String(text || '').toLowerCase();
  if (expected.some((name) => textValue.includes(`@${name}`))) return true;
  return mentionNamesFromMessage(message)
    .map((name) => name.toLowerCase())
    .some((name) => expected.includes(name) || expected.some((expectedName) => name.includes(expectedName)));
}

async function reply(messageId, text) {
  const feishu = await new FeishuClient().init();
  return feishu.replyText(messageId, text);
}

async function handleMessage(data) {
  const message = data && data.message;
  if (!message || !message.message_id) return;
  if (processedMessageIds.has(message.message_id)) return;
  processedMessageIds.add(message.message_id);
  if (processedMessageIds.size > 5000) processedMessageIds.clear();

  if (message.message_type !== 'text') return;
  const text = parseMessageText(message).trim();
  const isViklikMode = /viklik/i.test(process.env.FEISHU_DOC_ENV_PATH || process.env.FEISHU_ENV_PATH || '');
  const isTargetBot = isViklikMode
    ? hasBotMention(message, text, ['晨报数据更新机器人'])
    : isFinalUpdateCommand(text);
  if (!isTargetBot) return;
  const businessDate = parseBusinessDate(text);
  if (!businessDate) return;
  if (!claimFinalCommand(message.message_id)) return;

  await reply(message.message_id, isViklikMode
    ? `收到，开始回写 ${businessDate} 的 ai匹配表...`
    : `收到，开始生成 ${businessDate} 的最终修正表...`);

  try {
    if (isViklikMode) {
      const result = await finalizeViklikAiMatch({ businessDate });
      await reply(message.message_id, formatViklikFinalSummary(result));
    } else {
      const result = await finalizeDailyCorrection({ businessDate });
      await reply(message.message_id, formatFinalSummary(result));
    }
  } catch (error) {
    const details = error.details || { message: error.message };
    console.log(JSON.stringify(details, null, 2));
    await reply(message.message_id, `处理失败：${details.msg || details.message || '未知错误'}`);
  }
}

async function main() {
  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    domain: Lark.Domain.Lark,
  };

  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': handleMessage,
  });

  const client = new Lark.WSClient(baseConfig);
  client.start({ eventDispatcher: dispatcher });
  console.log('final correction bot started');
  console.log(`env: ${config.envPath}`);
  console.log(`doc env: ${process.env.FEISHU_DOC_ENV_PATH || ''}`);
  console.log('command example: 更新六月八号数据');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
