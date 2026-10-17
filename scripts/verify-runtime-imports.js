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
  const files = records.filter(item => item.type === 'file' && (item.path.startsWith('build/src/') || item.path.startsWith('integrations/codex-host/') || item.path === 'build/package.json'))
    .map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (inventory.schema_version !== '1.0' || JSON.stringify(inventory.files) !== JSON.stringify(files)) {
    throw new Error('standalone runtime import inventory is missing, changed, or corrupt');
  }
}
module.exports = { verifyRuntimeImports };
