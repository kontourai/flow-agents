import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contained = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

function links(root) {
  const result = [];
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`package root is a symlink: ${root}`);
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) result.push(file);
      else if (entry.isDirectory()) walk(file);
    }
  };
  walk(root);
  return result;
}

/** Every publisher-owned file remains link-free, including dependency-shaped paths. */
export function assertShippedPackageLinks(root) {
  const shipped = links(root);
  if (shipped.length) throw new Error(`shipped package contains a symlink/workspace link: ${path.relative(root, shipped[0])}`);
}

/** npm may create nested production .bin links after extraction; no other waiver. */
export function assertInstalledPackageLinks(packageRoot, consumerRoot, shippedRoot) {
  const consumer = fs.realpathSync(consumerRoot);
  const installed = fs.realpathSync(packageRoot);
  if (!contained(consumer, installed)) throw new Error('installed package escapes its consumer');
  const shippedPaths = new Set();
  if (shippedRoot) {
    assertShippedPackageLinks(shippedRoot);
    const collect = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        shippedPaths.add(path.relative(shippedRoot, file).split(path.sep).join('/'));
        if (entry.isDirectory()) collect(file);
      }
    };
    collect(shippedRoot);
  }
  const accepted = [];
  for (const file of links(packageRoot)) {
    const relative = path.relative(packageRoot, file).split(path.sep).join('/');
    if (shippedPaths.has(relative)) throw new Error(`publisher-owned installed path became a symlink: ${relative}`);
    const modules = path.dirname(path.dirname(file));
    if (!relative.startsWith('node_modules/') || path.basename(path.dirname(file)) !== '.bin' || path.basename(modules) !== 'node_modules') {
      throw new Error(`installed package contains an unexpected symlink/workspace link: ${relative}`);
    }
    const target = fs.realpathSync(file);
    if (!contained(consumer, target) || !fs.statSync(target).isFile()) throw new Error(`npm bin target escapes its consumer or is not a file: ${relative}`);
    let owner = path.dirname(target), declaration = null;
    while (contained(consumer, owner) && owner !== consumer) {
      const metadata = path.join(owner, 'package.json');
      if (fs.existsSync(metadata)) {
        const stat = fs.lstatSync(metadata);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`npm bin owner metadata is not a regular file: ${relative}`);
        const candidate = JSON.parse(fs.readFileSync(metadata, 'utf8'));
        if (typeof candidate.name === 'string' && typeof candidate.version === 'string') { declaration = candidate; break; }
      }
      owner = path.dirname(owner);
    }
    if (!declaration || !contained(path.join(consumer, 'node_modules'), owner)) throw new Error(`npm bin lacks an installed package owner: ${relative}`);
    const placement = path.relative(fs.realpathSync(modules), owner).split(path.sep);
    if (!(placement.length === 1 && placement[0] && !placement[0].startsWith('@') && placement[0] !== '..'
      || placement.length === 2 && placement[0].startsWith('@') && placement[1])) {
      throw new Error(`npm bin owner does not belong to its node_modules directory: ${relative}`);
    }
    const entries = typeof declaration.bin === 'string'
      ? [[declaration.name.split('/').at(-1), declaration.bin]]
      : declaration.bin && typeof declaration.bin === 'object' && !Array.isArray(declaration.bin) ? Object.entries(declaration.bin) : [];
    const command = path.basename(file);
    const declared = entries.some(([name, value]) => {
      if (name !== command || typeof value !== 'string' || !value || path.isAbsolute(value)) return false;
      const declaredTarget = path.resolve(owner, value);
      return contained(owner, declaredTarget) && fs.existsSync(declaredTarget)
        && contained(owner, fs.realpathSync(declaredTarget)) && fs.realpathSync(declaredTarget) === target;
    });
    if (!declared) throw new Error(`npm bin link is not declared by its owning package: ${relative}`);
    accepted.push({ path: relative, target, package: declaration.name, version: declaration.version });
  }
  return accepted;
}

const invokedScript = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (invokedScript === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [shippedRoot, packageRoot, consumerRoot] = process.argv.slice(2);
  assertShippedPackageLinks(shippedRoot);
  console.log(JSON.stringify({ shipped_links: 0, npm_owned_bin_links: assertInstalledPackageLinks(packageRoot, consumerRoot, shippedRoot) }));
}
