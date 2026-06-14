function extractUrls(text) {
  return String(text || '').match(/https?:\/\/[^\s<>"']+/g) || [];
}

function stripTrailingPunctuation(url) {
  return url.replace(/[，。；;,.!?）)]+$/g, '');
}

function detectUrlType(url) {
  const parsed = new URL(url);
  if (parsed.pathname.includes('/wiki/') || parsed.pathname.includes('/sheets/')) return 'rawUrl';
  if (parsed.pathname.includes('/base/')) return 'shooterUrl';
  return 'unknown';
}

function getLabeledValue(text, labels) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    for (const label of labels) {
      const pattern = new RegExp(`^\\s*${label}\\s*[:：]\\s*(.+?)\\s*$`, 'i');
      const match = line.match(pattern);
      if (match) return match[1].trim();
    }
  }
  return '';
}

function parseCommand(text) {
  const urls = extractUrls(text).map(stripTrailingPunctuation);
  const result = {
    rawUrl: '',
    shooterUrl: '',
    name: '',
    errors: [],
  };

  const rawLabeled = getLabeledValue(text, ['原始表', '原始数据', 'xmp原始数据', 'rawUrl']);
  const shooterLabeled = getLabeledValue(text, ['投手表', '投手填写表', '投手数据', 'shooterUrl']);
  const nameLabeled = getLabeledValue(text, ['名称', '新表名称', '修正表名称', 'name']);

  if (rawLabeled && rawLabeled.startsWith('http')) result.rawUrl = stripTrailingPunctuation(rawLabeled);
  if (shooterLabeled && shooterLabeled.startsWith('http')) result.shooterUrl = stripTrailingPunctuation(shooterLabeled);
  if (nameLabeled) result.name = nameLabeled;

  for (const url of urls) {
    const type = detectUrlType(url);
    if (type === 'rawUrl' && !result.rawUrl) result.rawUrl = url;
    if (type === 'shooterUrl' && !result.shooterUrl) result.shooterUrl = url;
  }

  if (!result.name) {
    const nameMatch = String(text || '').match(/(?:复制表为|命名为|名称[:：])\s*([^\n\r，,。]+)/);
    if (nameMatch) result.name = nameMatch[1].trim();
  }

  if (!result.rawUrl) result.errors.push('缺少原始数据 wiki/sheet 链接');
  if (!result.shooterUrl) result.errors.push('缺少投手填写多维表格 base 链接');
  if (!result.name) result.errors.push('缺少新表名称，例如：名称：六月九号修正数据');

  return result;
}

function commandHelp() {
  return [
    '请按下面格式发送：',
    '',
    '处理数据',
    '原始表：https://...',
    '投手表：https://...',
    '名称：六月九号修正数据',
  ].join('\n');
}

module.exports = {
  parseCommand,
  commandHelp,
};
