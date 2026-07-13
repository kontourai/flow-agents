#!/usr/bin/env bash
# install-codex-home.sh - Install Flow Agents into a Codex home.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FA_BUNDLE_SNAPSHOT_ROOT="$(mktemp -d /tmp/fa-codex-bundle-snapshot.XXXXXX)"
trap 'rm -rf "$FA_BUNDLE_SNAPSHOT_ROOT"' EXIT

validate_shipped_bundle() {
  if node - "$ROOT_DIR" "$FA_BUNDLE_SNAPSHOT_ROOT/codex" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

try {
const root = process.argv[2];
const source = path.join(root, "dist/codex");
const snapshot = process.argv[3];

function readRegular(file) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`required regular file is unsafe: ${file}`);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`source anchor changed while opening: ${file}`);
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error(`source file changed while reading: ${file}`);
    return content;
  } finally {
    fs.closeSync(fd);
  }
}

function scan(copy) {
  const records = [];
  function visit(absolute, relative) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`shipped bundle contains symlink: dist/codex/${relative}`);
    if (stat.isDirectory()) {
      records.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
      if (copy) fs.mkdirSync(path.join(snapshot, relative), { recursive: true, mode: 0o700 });
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(absolute, entry), path.join(relative, entry));
      return;
    }
    if (!stat.isFile()) throw new Error(`shipped bundle contains non-regular entry: dist/codex/${relative}`);
    const content = readRegular(absolute);
    records.push({
      path: relative,
      type: "file",
      mode: stat.mode & 0o777,
      size: content.length,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
    });
    if (copy) {
      const target = path.join(snapshot, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, content, { mode: stat.mode & 0o777, flag: "wx" });
    }
  }
  const anchor = fs.lstatSync(source);
  if (anchor.isSymbolicLink() || !anchor.isDirectory()) throw new Error("dist/codex must be a real directory");
  if (copy) fs.mkdirSync(snapshot, { mode: 0o700 });
  for (const entry of fs.readdirSync(source).sort()) visit(path.join(source, entry), entry);
  return records;
}

const first = scan(true);
const second = scan(false);
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("shipped Codex bundle changed while it was being snapshotted");

const packageJson = JSON.parse(readRegular(path.join(root, "package.json")).toString("utf8"));
const requiredFiles = [
  ".codex/hooks.json",
  ".agents/skills/deliver/SKILL.md",
  "build/package.json",
  "build/src/cli.js",
  "scripts/install-owned-files.js",
  "scripts/install-merge.js",
  "scripts/classify-codex-legacy-agents.js",
  "packaging/codex-legacy-agents-fingerprints.json",
];
for (const relative of requiredFiles) {
  const file = path.join(snapshot, relative);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
    throw new Error(`missing or empty ${relative}`);
  }
}
const hooks = JSON.parse(fs.readFileSync(path.join(snapshot, requiredFiles[0]), "utf8"));
if (!hooks || typeof hooks !== "object" || !hooks.hooks || typeof hooks.hooks !== "object") {
  throw new Error(".codex/hooks.json has no hooks object");
}
const bundlePackage = JSON.parse(fs.readFileSync(path.join(snapshot, requiredFiles[2]), "utf8"));
if (bundlePackage.name !== packageJson.name || bundlePackage.version !== packageJson.version) {
  throw new Error("dist/codex/build/package.json does not match the package name and version");
}
} catch (error) {
  console.error(`install-codex-home.sh: shipped bundle validation failed: ${error.message}`);
  process.exit(1);
}
NODE
  then
    return 0
  fi

  cat >&2 <<'EOF'
install-codex-home.sh: required prebuilt Codex bundle is missing or invalid.
This @kontourai/flow-agents package is incomplete or corrupt; reinstall it and retry.
If you are running from a source checkout, regenerate the bundle with: npm run build:bundles
EOF
  return 1
}

validate_shipped_bundle
BUNDLE_SOURCE="$FA_BUNDLE_SNAPSHOT_ROOT/codex"

usage() {
  cat >&2 <<'EOF'
usage: install-codex-home.sh [destination] [options]

Options:
  --telemetry-sink NAME   local-files, local-kontour-console,
                          kontour-hosted-console, user-hosted-console,
                          or legacy aliases. May be repeated.
  --console-url URL       Persist Console telemetry base URL.
  --console-endpoint URL  Persist full Console telemetry records endpoint URL.
  --console-token-file PATH
                          Read Console telemetry bearer token from a file.
  --console-tenant ID     Persist Console tenant identifier.
  --skills-dir PATH       Install portable skills here (default: $HOME/.agents/skills).
EOF
}

DEST="${CODEX_HOME:-$HOME/.codex}"
SKILLS_DIR="${FLOW_AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
DEST_SET=0
CONSOLE_CONFIG_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skills-dir)
      [[ $# -ge 2 ]] || { echo "install-codex-home.sh: $1 requires a value" >&2; exit 2; }
      SKILLS_DIR="$2"
      shift 2
      ;;
    --telemetry-sink|--telemetry-sinks|--console-url|--console-endpoint|--console-endpoint-url|--console-token-file|--console-tenant|--console-tenant-id)
      [[ $# -ge 2 ]] || { echo "install-codex-home.sh: $1 requires a value" >&2; exit 2; }
      CONSOLE_CONFIG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    -*)
      echo "install-codex-home.sh: unknown option: $1" >&2
      usage
      exit 2
      ;;
    *)
      if [[ "$DEST_SET" -eq 1 ]]; then
        echo "install-codex-home.sh: unexpected argument: $1" >&2
        usage
        exit 2
      fi
      DEST="$1"
      DEST_SET=1
      shift
      ;;
  esac
done
REAL_CODEX_HOME="${CODEX_REAL_HOME:-$HOME/.codex}"

canonicalize_path() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
let current = path.resolve(process.argv[2]);
const missing = [];
while (!fs.existsSync(current)) {
  missing.unshift(path.basename(current));
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
process.stdout.write(path.resolve(fs.realpathSync(current), ...missing));
NODE
}

[[ ! -L "$DEST" ]] || { echo "install-codex-home.sh: refusing symlink destination root: $DEST" >&2; exit 1; }
[[ ! -L "$SKILLS_DIR" ]] || { echo "install-codex-home.sh: refusing symlink skills destination root: $SKILLS_DIR" >&2; exit 1; }
ROOT_REAL="$(canonicalize_path "$ROOT_DIR")"
BUNDLE_SOURCE_REAL="$(canonicalize_path "$ROOT_DIR/dist/codex")"
DEST_REAL="$(canonicalize_path "$DEST")"
SKILLS_DIR_REAL="$(canonicalize_path "$SKILLS_DIR")"
if ! node - "$SKILLS_DIR" <<'NODE'
const fs = require("node:fs"); const path = require("node:path");
const absolute = path.resolve(process.argv[2]);
let current = path.parse(absolute).root;
for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  // macOS exposes /tmp as the system-managed /private/tmp symlink. Treat that
  // mount alias as trusted while rejecting caller-controlled components.
  if (current !== "/tmp" && fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) process.exit(1);
}
NODE
then
  echo "install-codex-home.sh: refusing symlink component in skills destination: $SKILLS_DIR" >&2
  exit 1
fi
REAL_CODEX_HOME_REAL="$(canonicalize_path "$REAL_CODEX_HOME")"
case "$DEST_REAL/" in
  "$ROOT_REAL/"*|"$BUNDLE_SOURCE_REAL/"*)
    echo "install-codex-home.sh: destination overlaps Flow Agents source: $DEST_REAL" >&2
    exit 1
    ;;
esac
case "$ROOT_REAL/" in
  "$DEST_REAL/"*)
    echo "install-codex-home.sh: Flow Agents source overlaps destination: $DEST_REAL" >&2
    exit 1
    ;;
esac
case "$SKILLS_DIR_REAL/" in
  "$ROOT_REAL/"*|"$BUNDLE_SOURCE_REAL/"*) echo "install-codex-home.sh: skills destination overlaps Flow Agents source: $SKILLS_DIR_REAL" >&2; exit 1 ;;
esac
case "$ROOT_REAL/" in
  "$SKILLS_DIR_REAL/"*) echo "install-codex-home.sh: Flow Agents source overlaps skills destination: $SKILLS_DIR_REAL" >&2; exit 1 ;;
esac
case "$BUNDLE_SOURCE_REAL/" in
  "$SKILLS_DIR_REAL/"*) echo "install-codex-home.sh: generated bundle source overlaps skills destination: $SKILLS_DIR_REAL" >&2; exit 1 ;;
esac
SKILLS_PATH_ROOT="$(node -e 'process.stdout.write(require("node:path").parse(process.argv[1]).root)' "$SKILLS_DIR_REAL")"
[[ "$SKILLS_DIR_REAL" != "$SKILLS_PATH_ROOT" ]] || { echo "install-codex-home.sh: refusing filesystem-root skills destination: $SKILLS_DIR_REAL" >&2; exit 1; }

assert_safe_dest_path() {
  local rel="$1"
  local current="$DEST"
  local part
  IFS='/' read -r -a parts <<< "$rel"
  for part in "${parts[@]}"; do
    [[ -n "$part" && "$part" != "." ]] || continue
    [[ "$part" != ".." ]] || { echo "install-codex-home.sh: unsafe destination path: $rel" >&2; exit 1; }
    current="$current/$part"
    if [[ -L "$current" ]]; then
      echo "install-codex-home.sh: refusing to write through symlink: $current" >&2
      exit 1
    fi
  done
  local parent
  parent="$(dirname "$current")"
  mkdir -p "$parent"
  local parent_real
  parent_real="$(cd "$parent" && pwd -P)"
  case "$parent_real/" in
    "$DEST_REAL"/*) ;;
    *) echo "install-codex-home.sh: destination escapes Codex home: $current" >&2; exit 1 ;;
  esac
}

FA_USER_HOOKS_STASH=""

# A real Codex home can contain user-owned files in every shared directory.
# Prepare an exact Flow Agents overlay, then synchronize only files recorded in
# the ownership manifest. The synchronizer never uses directory-wide --delete:
# it removes only unchanged files from its prior manifest and refuses collisions.
FA_OWNED_OVERLAY="$(mktemp -d /tmp/fa-codex-overlay.XXXXXX)"
FA_SKILLS_OVERLAY="$(mktemp -d /tmp/fa-codex-skills-overlay.XXXXXX)"
cleanup_install_temps() {
  rm -rf "$FA_BUNDLE_SNAPSHOT_ROOT"
  rm -rf "$FA_OWNED_OVERLAY"
  rm -rf "$FA_SKILLS_OVERLAY"
  [[ -z "${FA_USER_HOOKS_STASH:-}" ]] || rm -f "$FA_USER_HOOKS_STASH"
}
trap cleanup_install_temps EXIT

for managed_dir in \
  .flow-agents \
  agent-cards \
  build \
  context \
  docs \
  evals \
  integrations \
  packaging \
  powers \
  prompts \
  schemas \
  scripts
do
  if [[ -d "$BUNDLE_SOURCE/$managed_dir" ]]; then
    mkdir -p "$FA_OWNED_OVERLAY/$managed_dir"
    rsync -a "$BUNDLE_SOURCE/$managed_dir/" "$FA_OWNED_OVERLAY/$managed_dir/"
  fi
done

# Portable skills use Codex's universal catalog, independently of CODEX_HOME.
if [[ -d "$BUNDLE_SOURCE/.agents/skills" ]]; then
  rsync -a "$BUNDLE_SOURCE/.agents/skills/" "$FA_SKILLS_OVERLAY/"
fi

if [[ -d "$BUNDLE_SOURCE/kits" ]]; then
  mkdir -p "$FA_OWNED_OVERLAY/kits"
  rsync -a --exclude 'local/' "$BUNDLE_SOURCE/kits/" "$FA_OWNED_OVERLAY/kits/"
fi

# Agents are user-extensible in a real Codex home. Merge generated agents
# without deleting user-owned agents.
if [[ -d "$BUNDLE_SOURCE/.codex/agents" ]]; then
  mkdir -p "$FA_OWNED_OVERLAY/agents"
  rsync -a "$BUNDLE_SOURCE/.codex/agents/" "$FA_OWNED_OVERLAY/agents/"
fi

for bundle_file in README.md console.telemetry.json install.sh; do
  if [[ -f "$BUNDLE_SOURCE/$bundle_file" ]]; then
    cp "$BUNDLE_SOURCE/$bundle_file" "$FA_OWNED_OVERLAY/$bundle_file"
  fi
done

# Check both destinations with the exact synchronizer before either can mutate.
node "$BUNDLE_SOURCE/scripts/install-owned-files.js" \
  --check "$FA_SKILLS_OVERLAY" "$SKILLS_DIR_REAL" ".flow-agents/codex-universal-skills-install-manifest.json"
node "$BUNDLE_SOURCE/scripts/install-owned-files.js" \
  --check "$FA_OWNED_OVERLAY" "$DEST_REAL" ".flow-agents/codex-install-manifest.json"

# Refuse an exact historical Flow Agents global instruction file after both
# install destinations pass read-only preflight and before any install write.
# The classifier is intentionally read-only; remediation is operator-owned.
node "$BUNDLE_SOURCE/scripts/classify-codex-legacy-agents.js" \
  "$DEST_REAL" "$BUNDLE_SOURCE/packaging/codex-legacy-agents-fingerprints.json"

mkdir -p "$SKILLS_DIR"
SKILLS_DIR="$(cd "$SKILLS_DIR" && pwd -P)"
node "$BUNDLE_SOURCE/scripts/install-owned-files.js" \
  "$FA_SKILLS_OVERLAY" "$SKILLS_DIR" ".flow-agents/codex-universal-skills-install-manifest.json"

mkdir -p "$DEST"
DEST="$(cd "$DEST" && pwd -P)"
DEST_REAL="$DEST"
node "$BUNDLE_SOURCE/scripts/install-owned-files.js" \
  "$FA_OWNED_OVERLAY" "$DEST" ".flow-agents/codex-install-manifest.json"

# Stash the user's existing hooks.json (if any), so the merge step below can
# preserve user hooks across installs while replacing Flow Agents-managed groups.
assert_safe_dest_path "hooks.json"
if [[ -f "$DEST/hooks.json" ]]; then
  FA_USER_HOOKS_STASH="$(mktemp /tmp/fa-user-hooks.XXXXXX.json)"
  cp "$DEST/hooks.json" "$FA_USER_HOOKS_STASH"
fi

atomic_copy() {
  local source="$1"
  local rel="$2"
  assert_safe_dest_path "$rel"
  local target="$DEST/$rel"
  if [[ -e "$target" && ! -f "$target" ]]; then
    echo "install-codex-home.sh: refusing to replace non-file: $target" >&2
    exit 1
  fi
  local temp
  temp="$(mktemp "$(dirname "$target")/.flow-agents-install.XXXXXX")"
  cp "$source" "$temp"
  mv -f "$temp" "$target"
}

# Root Codex config/profiles may be user-owned. Flow Agents does not install or
# seed global AGENTS.md instructions.
generated_profile_files=()
profile_names=()
for seed_source in "$BUNDLE_SOURCE/.codex/config.toml" "$BUNDLE_SOURCE"/.codex/*.config.toml; do
  [[ -f "$seed_source" ]] || continue
  seed_file="$(basename "$seed_source")"
  if [[ "$seed_file" == *.config.toml ]]; then
    generated_profile_files+=("$seed_file")
    profile_names+=("${seed_file%.config.toml}")
  fi
  if [[ ! -e "$DEST/$seed_file" ]] || grep -q 'Generated from packaging/manifest.json' "$DEST/$seed_file"; then
    atomic_copy "$seed_source" "$seed_file"
  fi
done
for profile_path in "$DEST"/*.config.toml; do
  [[ -f "$profile_path" ]] || continue
  profile_file="$(basename "$profile_path")"
  keep_generated=0
  for generated_file in "${generated_profile_files[@]}"; do
    if [[ "$profile_file" == "$generated_file" ]]; then
      keep_generated=1
      break
    fi
  done
  if [[ "$keep_generated" -eq 0 ]] && grep -q 'Generated from packaging/manifest.json' "$profile_path"; then
    assert_safe_dest_path "$profile_file"
    rm -f "$profile_path"
  fi
done
rmdir "$DEST/.codex" 2>/dev/null || true

for auth_file in auth.json version.json installation_id models_cache.json; do
  if [[ "$REAL_CODEX_HOME_REAL" != "$DEST_REAL" && -f "$REAL_CODEX_HOME_REAL/$auth_file" ]]; then
    atomic_copy "$REAL_CODEX_HOME_REAL/$auth_file" "$auth_file"
  fi
done

chmod 700 "$DEST" 2>/dev/null || true
[[ -f "$DEST/auth.json" ]] && chmod 600 "$DEST/auth.json" 2>/dev/null || true

# Merge FA hooks into the flattened hooks.json, preserving any user hooks already present.
# The managed-hooks source is the bundle's .codex/hooks.json (pre-flatten, always present in dist/codex/).
# The rsync above wrote the FA hooks.json directly to $DEST/hooks.json.
# If the user had a hooks.json before this install, use the stash as the "existing" config so
# user-owned hook groups survive. Otherwise, $DEST/hooks.json is already correct (FA only).
FA_VERSION="$(node -p "require('$BUNDLE_SOURCE/build/package.json').version" 2>/dev/null || echo unknown)"
FA_MANAGED_HOOKS="$BUNDLE_SOURCE/.codex/hooks.json"
if command -v node >/dev/null 2>&1 && [[ -f "$FA_MANAGED_HOOKS" ]]; then
  FA_HOOKS_WORK="${FA_USER_HOOKS_STASH:-}"
  if [[ -z "$FA_HOOKS_WORK" ]]; then
    FA_HOOKS_WORK="$(mktemp /tmp/fa-hooks-work.XXXXXX.json)"
    printf '{"hooks":{}}\n' > "$FA_HOOKS_WORK"
  fi
  FA_INSTALL_RECORD_WORK="$(mktemp /tmp/fa-install-record.XXXXXX.json)"
  node "$BUNDLE_SOURCE/scripts/install-merge.js" \
    --config "$FA_HOOKS_WORK" \
    --managed-hooks "$FA_MANAGED_HOOKS" \
    --version "$FA_VERSION" \
    --install-record "$FA_INSTALL_RECORD_WORK" \
    --runtime "codex"
  atomic_copy "$FA_HOOKS_WORK" "hooks.json"
  atomic_copy "$FA_INSTALL_RECORD_WORK" ".flow-agents/install.json"
  rm -f "$FA_HOOKS_WORK" "$FA_INSTALL_RECORD_WORK"
  FA_USER_HOOKS_STASH=""
fi

if [[ ${#CONSOLE_CONFIG_ARGS[@]} -gt 0 || -n "${FLOW_AGENTS_TELEMETRY_SINK:-}" || -n "${FLOW_AGENTS_TELEMETRY_SINKS:-}" || -n "${FLOW_AGENTS_CONSOLE_URL:-}" || -n "${CONSOLE_TELEMETRY_URL:-}" || -n "${CONSOLE_URL:-}" || -n "${FLOW_AGENTS_CONSOLE_TOKEN_FILE:-}" || -n "${CONSOLE_TELEMETRY_TOKEN_FILE:-}" ]]; then
  bash "$DEST/scripts/telemetry/install-console-config.sh" "$DEST/scripts/telemetry/telemetry.conf" "${CONSOLE_CONFIG_ARGS[@]}"
fi

echo "Installed Flow Agents into Codex home at $DEST"
echo "Installed portable skills at $SKILLS_DIR"
if [[ "${#profile_names[@]}" -gt 0 ]]; then
  echo "Profiles: ${profile_names[*]}"
fi
echo "Use: codex --profile builder"
