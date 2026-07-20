#!/bin/sh
set -eu
action="${1:-}"
source_file="${2:-packaging/lifecycle-authority/coordinator.mjs}"
install_dir="/usr/local/libexec/kontourai"
target="$install_dir/flow-agents-lifecycle-authority-v1"
backup="$install_dir/flow-agents-lifecycle-authority-v1.previous"
if [ "$(id -u)" -ne 0 ]; then echo "lifecycle authority administration requires root" >&2; exit 77; fi
case "$action" in
  install|upgrade)
    test -f "$source_file"
    mkdir -p "$install_dir"
    chown root:wheel "$install_dir" 2>/dev/null || chown root:root "$install_dir"
    chmod 755 "$install_dir"
    if [ -f "$target" ]; then cp -p "$target" "$backup"; fi
    temporary="$target.$$"
    cp "$source_file" "$temporary"
    chown root:wheel "$temporary" 2>/dev/null || chown root:root "$temporary"
    chmod 755 "$temporary"
    mv -f "$temporary" "$target"
    ;;
  rollback)
    test -f "$backup"
    mv -f "$backup" "$target"
    chown root:wheel "$target" 2>/dev/null || chown root:root "$target"
    chmod 755 "$target"
    ;;
  *) echo "usage: $0 <install|upgrade|rollback> [coordinator.mjs]" >&2; exit 64 ;;
esac
