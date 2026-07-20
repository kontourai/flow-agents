#!/bin/sh
set -eu
action="${1:-}"
source_file="${2:-packaging/lifecycle-authority/coordinator.mjs}"
runtime_file="$(dirname "$source_file")/runtime-v1.mjs"
reducer_pin_file="$(dirname "$source_file")/flow-reducer-v1.json"
flow_node_modules="${3:-node_modules}"
install_dir="/usr/local/libexec/kontourai"
target="$install_dir/flow-agents-lifecycle-authority-v1"
backup="$install_dir/flow-agents-lifecycle-authority-v1.previous"
target_runtime="$install_dir/runtime-v1.mjs"
backup_runtime="$install_dir/runtime-v1.mjs.previous"
target_pin="$install_dir/flow-reducer-v1.json"
backup_pin="$install_dir/flow-reducer-v1.json.previous"
target_flow="$install_dir/flow-reducer"
backup_flow="$install_dir/flow-reducer.previous"
if [ "$(id -u)" -ne 0 ]; then echo "lifecycle authority administration requires root" >&2; exit 77; fi
case "$action" in
  install|upgrade)
    test -f "$source_file" && test -f "$runtime_file" && test -f "$reducer_pin_file"
    test -f "$flow_node_modules/@kontourai/flow/package.json" && test -f "$flow_node_modules/@kontourai/flow/dist/index.js"
    node - "$flow_node_modules/@kontourai/flow/package.json" <<'NODE'
const metadata = require(process.argv[2]);
if (metadata.name !== '@kontourai/flow' || metadata.version !== '3.5.0') process.exit(1);
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
    ;;
  *) echo "usage: $0 <install|upgrade|rollback> [coordinator.mjs] [node_modules]" >&2; exit 64 ;;
esac
