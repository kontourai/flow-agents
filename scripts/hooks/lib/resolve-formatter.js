'use strict';

const fs = require('fs');
const path = require('path');

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierrc.cjs',
  '.prettierrc.mjs', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.toml',
  'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs',
];
const ROOT_MARKERS = ['package.json', ...BIOME_CONFIGS, ...PRETTIER_CONFIGS];

const FORMATTER_PACKAGES = {
  biome: { binName: 'biome', pkgName: '@biomejs/biome' },
  prettier: { binName: 'prettier', pkgName: 'prettier' },
};

const rootCache = new Map();
const formatterCache = new Map();
const binCache = new Map();

function findProjectRoot(startDir) {
  if (rootCache.has(startDir)) return rootCache.get(startDir);
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (ROOT_MARKERS.some(m => fs.existsSync(path.join(dir, m)))) {
      rootCache.set(startDir, dir);
      return dir;
    }
    dir = path.dirname(dir);
  }
  rootCache.set(startDir, startDir);
  return startDir;
}

function detectFormatter(projectRoot) {
  if (formatterCache.has(projectRoot)) return formatterCache.get(projectRoot);
  if (BIOME_CONFIGS.some(f => fs.existsSync(path.join(projectRoot, f)))) {
    formatterCache.set(projectRoot, 'biome');
    return 'biome';
  }
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if ('prettier' in pkg) {
        formatterCache.set(projectRoot, 'prettier');
        return 'prettier';
      }
    }
  } catch { /* malformed package.json */ }
  if (PRETTIER_CONFIGS.some(f => fs.existsSync(path.join(projectRoot, f)))) {
    formatterCache.set(projectRoot, 'prettier');
    return 'prettier';
  }
  formatterCache.set(projectRoot, null);
  return null;
}

function resolveFormatterBin(projectRoot, formatter) {
  const key = `${projectRoot}:${formatter}`;
  if (binCache.has(key)) return binCache.get(key);
  const pkg = FORMATTER_PACKAGES[formatter];
  if (!pkg) { binCache.set(key, null); return null; }
  const localBin = path.join(projectRoot, 'node_modules', '.bin', pkg.binName);
  const result = fs.existsSync(localBin)
    ? { bin: localBin, prefix: [] }
    : { bin: 'npx', prefix: [pkg.pkgName] };
  binCache.set(key, result);
  return result;
}

function clearCaches() {
  rootCache.clear();
  formatterCache.clear();
  binCache.clear();
}

module.exports = { findProjectRoot, detectFormatter, resolveFormatterBin, clearCaches };
