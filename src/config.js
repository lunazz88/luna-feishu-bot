const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const NODE_MODULES_DIR = path.join(PROJECT_DIR, 'node_modules');
const DEFAULT_PYTHON = path.join(PROJECT_DIR, '.venv', 'bin', 'python');

require(path.join(NODE_MODULES_DIR, 'dotenv')).config({
  path: path.join(PROJECT_DIR, '.env'),
  quiet: true,
});

function envList(name, fallback) {
  return (process.env[name] || fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

const config = {
  baseUrl: (process.env.FEISHU_BASE_URL || 'https://open.larksuite.com').replace(/\/+$/, ''),
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
  tenantDomain: process.env.FEISHU_TENANT_DOMAIN || 'test-dj53i7nevqb8.sg.larksuite.com',
  nodeModulesDir: NODE_MODULES_DIR,
  pythonExe: process.env.CODEX_PYTHON_EXE || DEFAULT_PYTHON,
  shooterBaseUrl:
    process.env.FEISHU_SHOOTER_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/base/Xr9Kb1GFHauf32sGV9xlCFJMg1e?from=from_copylink',
  aiCorrectionBaseUrl:
    process.env.FEISHU_AI_CORRECTION_BASE_URL ||
    'https://test-dj53i7nevqb8.sg.larksuite.com/wiki/ItYIwBpeZixDLBk5dwRljoNvgRh?from=from_copylink',
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
  resultViewNames: envList('FEISHU_RESULT_VIEW_NAMES', '所有项目,按投手,按项目,按国家'),
};

function assertConfig() {
  const missing = [];
  if (!config.baseUrl) missing.push('FEISHU_BASE_URL');
  if (!config.appId) missing.push('FEISHU_APP_ID');
  if (!config.appSecret) missing.push('FEISHU_APP_SECRET');
  if (missing.length) {
    throw new Error(`Missing Feishu config: ${missing.join(', ')}`);
  }
}

module.exports = {
  config,
  assertConfig,
};
