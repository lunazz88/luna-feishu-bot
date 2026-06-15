const path = require('path');
const { config } = require('./config');
const { FeishuClient } = require('./feishuClient');
const {
  finalizeDailyCorrection,
  formatFinalSummary,
  isFinalUpdateCommand,
  parseBusinessDate,
} = require('./finalizeDailyCorrection');

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
  if (!isFinalUpdateCommand(text)) return;

  const businessDate = parseBusinessDate(text);
  await reply(message.message_id, `收到，开始生成 ${businessDate} 的最终修正表...`);

  try {
    const result = await finalizeDailyCorrection({ businessDate });
    await reply(message.message_id, formatFinalSummary(result));
  } catch (error) {
    const details = error.details || { message: error.message };
    console.log(JSON.stringify(details, null, 2));
    await reply(message.message_id, `生成最终修正表失败：${details.msg || details.message || '未知错误'}`);
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
  console.log('command example: 更新六月八号数据');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
