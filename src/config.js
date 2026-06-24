const fs = require('fs');
const path = require('path');

const FEISHU_PROJECT_DIR = process.env.FEISHU_AUTOMATION_DIR || path.resolve(__dirname, '..');
const NODE_MODULES_DIR = path.join(FEISHU_PROJECT_DIR, 'node_modules');
const DEFAULT_CODEX_PYTHON = path.join(FEISHU_PROJECT_DIR, '.venv', 'bin', 'python');
const FEISHU_ENV_PATH = process.env.FEISHU_ENV_PATH || path.join(FEISHU_PROJECT_DIR, '.env.robot1');

require(path.join(NODE_MODULES_DIR, 'dotenv')).config({
  path: FEISHU_ENV_PATH,
  quiet: true,
});

const config = {
  baseUrl: (process.env.FEISHU_BASE_URL || 'https://open.larksuite.com').replace(/\/+$/, ''),
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
  tenantDomain: process.env.FEISHU_TENANT_DOMAIN || 'test-dj53i7nevqb8.sg.larksuite.com',
  envPath: FEISHU_ENV_PATH,
  nodeModulesDir: NODE_MODULES_DIR,
  pythonExe: process.env.CODEX_PYTHON_EXE || DEFAULT_CODEX_PYTHON,
  shooterBaseUrl:
    process.env.FEISHU_SHOOTER_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/base/Xr9Kb1GFHauf32sGV9xlCFJMg1e?from=from_copylink',
  aiCorrectionBaseUrl:
    process.env.FEISHU_AI_CORRECTION_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/wiki/ItYIwBpeZixDLBk5dwRljoNvgRh?from=from_copylink',
  aiConfirmedBaseUrl:
    process.env.FEISHU_AI_CONFIRMED_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/base/ET7qbQhdUaMBq6slrecldArmgyl?from=from_copylink',
  shooterMismatchBaseUrl:
    process.env.FEISHU_SHOOTER_MISMATCH_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/base/VtRwb4EuCadrmZsrxvtlfVXggOg?from=from_copylink',
  crawlFailureBaseUrl:
    process.env.FEISHU_CRAWL_FAILURE_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/base/AlL6bv2uzagDhdstJE6l6PjCgsb?from=from_copylink',
  unmatchedBaseUrl:
    process.env.FEISHU_UNMATCHED_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/wiki/D0QYwkOqiiuuHPklDz9lFvwHgfc?from=from_copylink',
  outputFolderToken: process.env.FEISHU_OUTPUT_FOLDER_TOKEN || '',
  resultChatId: process.env.FEISHU_RESULT_CHAT_ID || 'oc_7d2271c3d02bd4fe847dc8b4f8542108',
  permissionChatId: process.env.FEISHU_PERMISSION_CHAT_ID || process.env.FEISHU_RESULT_CHAT_ID || 'oc_7d2271c3d02bd4fe847dc8b4f8542108',
  xmpSourceChatId: process.env.FEISHU_XMP_SOURCE_CHAT_ID || '',
  xmpOperatorChatId: process.env.FEISHU_XMP_OPERATOR_CHAT_ID || '',
  resultViewNames: (process.env.FEISHU_RESULT_VIEW_NAMES || '所有项目,按投手,按项目,按国家')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
};

function parseEnvFile(file) {
  if (!file || !fs.existsSync(file)) return {};
  const parsed = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function configFromEnvFile(file) {
  const env = parseEnvFile(file);
  return {
    ...config,
    baseUrl: (env.FEISHU_BASE_URL || config.baseUrl || 'https://open.larksuite.com').replace(/\/+$/, ''),
    appId: env.FEISHU_APP_ID || config.appId,
    appSecret: env.FEISHU_APP_SECRET || config.appSecret,
    verificationToken: env.FEISHU_VERIFICATION_TOKEN || config.verificationToken,
    tenantDomain: env.FEISHU_TENANT_DOMAIN || config.tenantDomain,
    envPath: file,
    pythonExe: env.CODEX_PYTHON_EXE || config.pythonExe,
    shooterBaseUrl: env.FEISHU_SHOOTER_BASE_URL || config.shooterBaseUrl,
    aiCorrectionBaseUrl: env.FEISHU_AI_CORRECTION_BASE_URL || config.aiCorrectionBaseUrl,
    aiConfirmedBaseUrl: env.FEISHU_AI_CONFIRMED_BASE_URL || config.aiConfirmedBaseUrl,
    shooterMismatchBaseUrl: env.FEISHU_SHOOTER_MISMATCH_BASE_URL || config.shooterMismatchBaseUrl,
    crawlFailureBaseUrl: env.FEISHU_CRAWL_FAILURE_BASE_URL || config.crawlFailureBaseUrl,
    unmatchedBaseUrl: env.FEISHU_UNMATCHED_BASE_URL || config.unmatchedBaseUrl,
    outputFolderToken: env.FEISHU_OUTPUT_FOLDER_TOKEN || config.outputFolderToken,
    resultChatId: env.FEISHU_RESULT_CHAT_ID || config.resultChatId,
    permissionChatId: env.FEISHU_PERMISSION_CHAT_ID || env.FEISHU_RESULT_CHAT_ID || config.permissionChatId,
    xmpSourceChatId: env.FEISHU_XMP_SOURCE_CHAT_ID || config.xmpSourceChatId,
    xmpOperatorChatId: env.FEISHU_XMP_OPERATOR_CHAT_ID || config.xmpOperatorChatId,
    resultViewNames: (env.FEISHU_RESULT_VIEW_NAMES || config.resultViewNames.join(','))
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  };
}

function assertConfig(target = config) {
  const missing = [];
  if (!target.baseUrl) missing.push('FEISHU_BASE_URL');
  if (!target.appId) missing.push('FEISHU_APP_ID');
  if (!target.appSecret) missing.push('FEISHU_APP_SECRET');
  if (missing.length) {
    throw new Error(`Missing Feishu config: ${missing.join(', ')}`);
  }
}

module.exports = {
  config,
  configFromEnvFile,
  assertConfig,
};
