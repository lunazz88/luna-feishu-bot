const fs = require('fs');
const path = require('path');

function safeId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 160);
}

function claimFinalCommand(messageId, root = path.join(process.cwd(), 'outputs', 'final-command-locks')) {
  const id = safeId(messageId);
  if (!id) return true;

  fs.mkdirSync(root, { recursive: true });
  const lockDir = path.join(root, id);
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'claimed_at.txt'), new Date().toISOString(), 'utf8');
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

module.exports = {
  claimFinalCommand,
};
