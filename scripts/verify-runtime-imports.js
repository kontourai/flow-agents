// Shared integrity gate for standalone bundle imports. No npm resolution or build.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function verifyRuntimeImports(root, records) {
  if (!records) {
    records = [];
    function visit(relative) {
      const file = path.join(root, relative);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`standalone runtime contains symlink: ${relative}`);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(file).sort()) visit(`${relative}/${name}`);
      } else if (stat.isFile()) {
        records.push({ path: relative, type: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      } else throw new Error(`standalone runtime contains non-regular entry: ${relative}`);
    }
    for (const name of fs.readdirSync(root).sort()) visit(name);
  }
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'build/runtime-imports.json'), 'utf8'));
  const files = records.filter(item => item.type === 'file' && (item.path.startsWith('build/src/') || item.path.startsWith('integrations/codex-host/') || item.path === 'build/package.json' || item.path === '.codex/hooks.json' || item.path === '.claude/settings.json'))
    .map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (inventory.schema_version !== '1.0' || JSON.stringify(inventory.files) !== JSON.stringify(files)) {
    throw new Error('standalone runtime import inventory is missing, changed, or corrupt');
  }
}
// Read only the canonical owned seed during uninstall. Do not scan the user's
// whole home or require unrelated, user-modified runtime files to match.
function readVerifiedRuntimeFile(root, relative) {
  function readRegular(name) {
    const parts = name.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('unsafe runtime inventory path');
    let file = root;
    for (const part of parts) {
      file = path.join(file, part);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`standalone runtime contains symlink: ${name}`);
    }
    const anchor = fs.lstatSync(file);
    if (!anchor.isFile() || anchor.size > 16 * 1024 * 1024) throw new Error(`unsafe runtime file: ${name}`);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (before.dev !== anchor.dev || before.ino !== anchor.ino || !before.isFile() || before.size > 16 * 1024 * 1024) throw new Error(`unsafe runtime file: ${name}`);
      const bytes = fs.readFileSync(fd);
      const after = fs.fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error(`runtime file changed while reading: ${name}`);
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  const inventory = JSON.parse(readRegular('build/runtime-imports.json').toString('utf8'));
  const entries = Array.isArray(inventory.files) ? inventory.files.filter(entry => entry.path === relative) : [];
  if (inventory.schema_version !== '1.0' || entries.length !== 1 || !/^[a-f0-9]{64}$/.test(entries[0].sha256)) {
    throw new Error('standalone runtime seed inventory is missing, changed, or corrupt');
  }
  const bytes = readRegular(relative);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== entries[0].sha256) throw new Error('standalone runtime seed is missing, changed, or corrupt');
  return bytes;
}
module.exports = { verifyRuntimeImports, readVerifiedRuntimeFile };
