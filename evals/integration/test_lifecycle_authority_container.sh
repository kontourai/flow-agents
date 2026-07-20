#!/usr/bin/env bash
# Root/container conformance for the externally provisioned lifecycle authority.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v docker >/dev/null || { echo "SKIP: docker unavailable"; exit 77; }
docker run --rm -v "$ROOT_DIR:/src:ro" node:22-bookworm bash -lc '
  set -euo pipefail
  apt-get update -qq && apt-get install -y -qq sudo >/dev/null
  cp -a /src /work && cd /work
  npm ci --ignore-scripts --silent
  npm run build --silent
  scripts/lifecycle-authority-admin.sh install packaging/lifecycle-authority/coordinator.mjs node_modules kontourai-lifecycle-operator
  usermod -a -G kontourai-lifecycle-operator node
  test -f /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1
  visudo -cf /etc/sudoers.d/kontourai-flow-agents-lifecycle-authority-v1 >/dev/null
  stat -c "%U %a" /usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1 | grep -qx "root 755"
  su -s /bin/bash node -c "sudo -n -- /usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1 </dev/null" 2>&1 | grep -q "exactly one JSON request line"
  if su -s /bin/bash node -c "sudo -n -- /usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1 unexpected </dev/null"; then exit 1; fi
  if su -s /bin/bash nobody -c "sudo -n -- /usr/local/libexec/kontourai/flow-agents-lifecycle-authority-v1 </dev/null"; then exit 1; fi
  echo "PASS: root-owned helper, sudoers exact-command rule, and non-root operator boundary"
'
