#!/bin/sh
set -eu
action="${1:-}"
source_file="${2:-packaging/lifecycle-authority/coordinator.mjs}"
runtime_file="$(dirname "$source_file")/runtime-v1.mjs"
reducer_pin_file="$(dirname "$source_file")/flow-reducer-v1.json"
flow_node_modules="${3:-node_modules}"
operator_group="${4:-kontourai-lifecycle-operator}"
install_dir="/usr/local/libexec/kontourai"
target="$install_dir/flow-agents-lifecycle-authority-v1"
backup="$install_dir/flow-agents-lifecycle-authority-v1.previous"
target_runtime="$install_dir/runtime-v1.mjs"
backup_runtime="$install_dir/runtime-v1.mjs.previous"
target_pin="$install_dir/flow-reducer-v1.json"
backup_pin="$install_dir/flow-reducer-v1.json.previous"
target_flow="$install_dir/flow-reducer"
backup_flow="$install_dir/flow-reducer.previous"
sudoers_dir="/etc/sudoers.d"
sudoers_file="$sudoers_dir/kontourai-flow-agents-lifecycle-authority-v1"
sudoers_backup="$sudoers_file.previous"
if [ "$(id -u)" -ne 0 ]; then echo "lifecycle authority administration requires root" >&2; exit 77; fi
ensure_operator_group() {
  case "$(uname -s)" in
    Darwin) dseditgroup -o create "$operator_group" 2>/dev/null || true ;;
    Linux) getent group "$operator_group" >/dev/null 2>&1 || groupadd --system "$operator_group" ;;
    *) echo "unsupported platform for lifecycle operator group: $(uname -s)" >&2; exit 69 ;;
  esac
}
install_sudoers_rule() {
  ensure_operator_group
  mkdir -p "$sudoers_dir"
  sudoers_stage="$sudoers_file.$$"
  umask 077
  {
    echo "Defaults!$target env_reset,secure_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
    echo "%$operator_group ALL=(root) NOPASSWD: $target \"\""
  } > "$sudoers_stage"
  chown root:wheel "$sudoers_stage" 2>/dev/null || chown root:root "$sudoers_stage"
  chmod 440 "$sudoers_stage"
  visudo -cf "$sudoers_stage" >/dev/null
  if [ -f "$sudoers_file" ]; then cp -p "$sudoers_file" "$sudoers_backup"; fi
  mv -f "$sudoers_stage" "$sudoers_file"
}
case "$action" in
  install|upgrade)
    test -f "$source_file" && test -f "$runtime_file" && test -f "$reducer_pin_file"
    test -f "$flow_node_modules/@kontourai/flow/package.json" && test -f "$flow_node_modules/@kontourai/flow/dist/index.js"
    node - "$flow_node_modules" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const modules = path.resolve(process.argv[2]), root = path.resolve(modules, '@kontourai/flow');
const lock = JSON.parse(fs.readFileSync(path.join(modules, '.package-lock.json'), 'utf8')).packages;
const seen = new Set();
function rejectSymlink(file) { const stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw new Error(`staged Flow dependency must not contain symlinks: ${file}`); }
function check(packageRoot) {
  packageRoot = path.resolve(packageRoot); if (seen.has(packageRoot)) return; seen.add(packageRoot);
  if (!packageRoot.startsWith(`${modules}${path.sep}`)) throw new Error('Flow dependency escapes staged node_modules');
  rejectSymlink(packageRoot); const rel = path.relative(modules, packageRoot).split(path.sep).join('/');
  const entry = lock[`node_modules/${rel}`]; if (!entry || typeof entry.integrity !== 'string' || !/^sha(?:256|512)-/.test(entry.integrity)) throw new Error(`Flow dependency lacks pinned npm integrity: ${rel}`);
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')); rejectSymlink(path.join(packageRoot, 'package.json'));
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (String(range).startsWith('file:') || String(range).startsWith('link:')) throw new Error(`Flow dependency is not registry-pinned: ${name}`);
    const found = path.join(modules, name);
    if (!found) throw new Error(`Flow dependency is missing from staged closure: ${name}`); check(found);
  }
}
check(root);
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (metadata.name !== '@kontourai/flow' || metadata.version !== '3.5.0') process.exit(1);
const entry = path.join(root, 'dist', 'index.js'); rejectSymlink(entry);
if (!fs.statSync(entry).isFile()) throw new Error('Flow reducer entry is not a regular file');
process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex'));
NODE
    mkdir -p "$install_dir"
    chown root:wheel "$install_dir" 2>/dev/null || chown root:root "$install_dir"
    chmod 755 "$install_dir"
    flow_stage="$target_flow.$$"
    mkdir -p "$flow_stage"
    cp -R "$flow_node_modules" "$flow_stage/node_modules"
    chown -R root:wheel "$flow_stage" 2>/dev/null || chown -R root:root "$flow_stage"
    chmod -R go-w "$flow_stage"
    if [ -f "$target" ]; then cp -p "$target" "$backup"; fi
    if [ -f "$target_runtime" ]; then cp -p "$target_runtime" "$backup_runtime"; fi
    if [ -f "$target_pin" ]; then cp -p "$target_pin" "$backup_pin"; fi
    if [ -d "$target_flow" ]; then rm -rf "$backup_flow"; mv "$target_flow" "$backup_flow"; fi
    temporary="$target.$$"
    cp "$source_file" "$temporary"
    chown root:wheel "$temporary" 2>/dev/null || chown root:root "$temporary"
    chmod 755 "$temporary"
    cp "$runtime_file" "$target_runtime.$$"
    chown root:wheel "$target_runtime.$$" 2>/dev/null || chown root:root "$target_runtime.$$"
    chmod 644 "$target_runtime.$$"
    cp "$reducer_pin_file" "$target_pin.$$"
    chown root:wheel "$target_pin.$$" 2>/dev/null || chown root:root "$target_pin.$$"
    chmod 644 "$target_pin.$$"
    mv -f "$target_runtime.$$" "$target_runtime"
    mv -f "$target_pin.$$" "$target_pin"
    mv "$flow_stage" "$target_flow"
    mv -f "$temporary" "$target"
    install_sudoers_rule
    ;;
  rollback)
    test -f "$backup" && test -f "$backup_runtime" && test -f "$backup_pin" && test -d "$backup_flow"
    mv -f "$backup" "$target"
    chown root:wheel "$target" 2>/dev/null || chown root:root "$target"
    chmod 755 "$target"
    mv -f "$backup_runtime" "$target_runtime"
    chown root:wheel "$target_runtime" 2>/dev/null || chown root:root "$target_runtime"
    chmod 644 "$target_runtime"
    mv -f "$backup_pin" "$target_pin"
    chown root:wheel "$target_pin" 2>/dev/null || chown root:root "$target_pin"
    chmod 644 "$target_pin"
    rm -rf "$target_flow"
    mv "$backup_flow" "$target_flow"
    if [ -f "$sudoers_backup" ]; then mv -f "$sudoers_backup" "$sudoers_file"; else rm -f "$sudoers_file"; fi
    ;;
  *) echo "usage: $0 <install|upgrade|rollback> [coordinator.mjs] [node_modules] [operator-group]" >&2; exit 64 ;;
esac
