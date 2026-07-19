#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
REPRO_FIRST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-bundle-repro-a.XXXXXX")"
REPRO_SECOND_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-bundle-repro-b.XXXXXX")"
NESTED_FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-runtime-nested-fixture.XXXXXX")"
NESTED_DIST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/flow-agents-runtime-nested-dist.XXXXXX")"
REPRO_DIFF_FILE="${TMPDIR:-/tmp}/universal-bundle-reproducibility.diff"
pass=0
fail=0

cleanup() {
  rm -rf "$REPRO_FIRST_DIR" "$REPRO_SECOND_DIR" "$NESTED_FIXTURE_DIR" "$NESTED_DIST_DIR" "$ROOT_DIR/kits/zzz-collision-eval-probe" "${MISSING_SKILL_DIR:-}"
}
trap cleanup EXIT

_pass() { echo "  ✓ $1"; pass=$((pass + 1)); }
_fail() { echo "  ✗ $1"; fail=$((fail + 1)); }

echo "=== Layer 1B: Universal Bundle Validation ==="
echo ""

echo "--- Source Tree ---"
if (cd "$ROOT_DIR" && npm run validate:source >/tmp/source-tree-validation.txt 2>&1); then
  _pass "source tree validation passed"
else
  _fail "source tree validation failed (see /tmp/source-tree-validation.txt)"
fi

if (cd "$ROOT_DIR" && npm run typecheck >/tmp/source-tree-typecheck.txt 2>&1); then
  _pass "source tree validator typechecks"
else
  _fail "source tree validator does not typecheck"
fi

echo ""
echo "--- Build ---"
if (cd "$ROOT_DIR" && npm run build:bundles >/dev/null); then
  _pass "bundle build completed"
else
  _fail "bundle build failed"
fi

if (cd "$ROOT_DIR" && FLOW_AGENTS_DIST_DIR="$REPRO_FIRST_DIR" npm run build:bundles >/dev/null) \
  && (cd "$ROOT_DIR" && FLOW_AGENTS_DIST_DIR="$REPRO_SECOND_DIR" npm run build:bundles >/dev/null) \
  && diff -ru "$REPRO_FIRST_DIR" "$REPRO_SECOND_DIR" >"$REPRO_DIFF_FILE"; then
  _pass "bundle generation is reproducible from clean output directories"
else
  _fail "bundle generation is not reproducible from clean output directories (see $REPRO_DIFF_FILE)"
fi

if (cd "$ROOT_DIR" && npm run typecheck >/tmp/bundle-builder-typecheck.txt 2>&1); then
  _pass "bundle builder typechecks"
else
  _fail "bundle builder does not typecheck"
fi

if node - "$NESTED_FIXTURE_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const packages = {
  "root-a": { version: "1.0.0", dependencies: { shared: "1.0.0" } },
  "root-b": { version: "1.0.0", dependencies: { shared: "2.0.0" } },
  "shared": { version: "1.0.0", dependencies: {} },
  "root-b/node_modules/shared": { name: "shared", version: "2.0.0", dependencies: {} },
};
const rootDependencies = { "root-a": "1.0.0", "root-b": "1.0.0" };
fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "nested-runtime-fixture", version: "1.0.0", dependencies: rootDependencies }, null, 2)}\n`);
const lockPackages = { "": { name: "nested-runtime-fixture", version: "1.0.0", dependencies: rootDependencies } };
for (const [packagePath, spec] of Object.entries(packages)) {
  const name = spec.name ?? packagePath.split("/").at(-1);
  const lockPath = `node_modules/${packagePath}`;
  lockPackages[lockPath] = { version: spec.version, integrity: "sha512-QUFBQQ==", dependencies: spec.dependencies };
  const directory = path.join(root, lockPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify({ name, version: spec.version, dependencies: spec.dependencies }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "index.js"), `module.exports = ${JSON.stringify(spec.version)};\n`);
}
fs.writeFileSync(path.join(root, "package-lock.json"), `${JSON.stringify({ name: "nested-runtime-fixture", version: "1.0.0", lockfileVersion: 3, requires: true, packages: lockPackages }, null, 2)}\n`);
NODE
then
  if (cd "$ROOT_DIR" && FLOW_AGENTS_TEST_MODE=1 FLOW_AGENTS_RUNTIME_DEPENDENCY_FIXTURE_ROOT="$NESTED_FIXTURE_DIR" \
      FLOW_AGENTS_DIST_DIR="$NESTED_DIST_DIR" npm run build:bundles >/dev/null) \
    && node - "$NESTED_DIST_DIR/codex/build/runtime-dependencies.json" <<'NODE'
const fs = require("node:fs");
const closure = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const paths = closure.packages.map((item) => `${item.path}@${item.version}`);
const expected = ["root-a@1.0.0", "root-b@1.0.0", "root-b/node_modules/shared@2.0.0", "shared@1.0.0"];
if (JSON.stringify(paths) !== JSON.stringify(expected)) throw new Error(`nested topology mismatch: ${JSON.stringify(paths)}`);
const rootB = closure.packages.find((item) => item.path === "root-b");
if (rootB.dependencies[0]?.path !== "root-b/node_modules/shared") throw new Error("nested dependency edge was flattened");
const rootA = closure.packages.find((item) => item.path === "root-a");
if (rootA.dependencies[0]?.path !== "shared") throw new Error("hoisted dependency edge was not preserved");
NODE
  then
    _pass "lockfile closure preserves nested duplicate-version topology"
  else
    _fail "lockfile closure flattened or omitted nested duplicate-version topology"
  fi
else
  _fail "nested duplicate-version fixture could not be created"
fi

echo ""
echo "--- Bundle Layout ---"
for dir in "$DIST_DIR/kiro" "$DIST_DIR/claude-code" "$DIST_DIR/codex" "$DIST_DIR/opencode" "$DIST_DIR/pi"; do
  if [[ -d "$dir" ]]; then
    _pass "$(basename "$dir") bundle exists"
  else
    _fail "$(basename "$dir") bundle missing"
  fi
done

if node - "$ROOT_DIR/package.json" "$DIST_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [sourcePackageFile, dist] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourcePackageFile, "utf8"));
for (const runtime of ["base", "kiro", "claude-code", "codex", "opencode", "pi"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, runtime, "build", "package.json"), "utf8"));
  if (manifest.name !== "@kontourai/flow-agents" || manifest.version !== source.version || manifest.type !== "module") {
    throw new Error(`${runtime} build package identity does not match Flow Agents ${source.version}`);
  }
}
NODE
then
  _pass "all bundles stamp their compiled runtime with Flow Agents package identity"
else
  _fail "bundle compiled-runtime package identity is missing or stale"
fi

if node - "$ROOT_DIR/package.json" "$ROOT_DIR/package-lock.json" "$DIST_DIR" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [sourcePackageFile, lockFile, dist] = process.argv.slice(2);
const source = JSON.parse(fs.readFileSync(sourcePackageFile, "utf8"));
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const codexPackage = JSON.parse(fs.readFileSync(path.join(dist, "codex", "package.json"), "utf8"));
if (JSON.stringify(codexPackage.dependencies) !== JSON.stringify(source.dependencies)) {
  throw new Error("Codex runtime package dependencies do not match the source package");
}
for (const runtime of ["base", "kiro", "claude-code", "opencode", "pi"]) {
  if (fs.existsSync(path.join(dist, runtime, "package.json"))) {
    throw new Error(`${runtime} must not publish a root package.json into adopter workspaces`);
  }
}
const closure = JSON.parse(fs.readFileSync(path.join(dist, "codex", "build", "runtime-dependencies.json"), "utf8"));
if (closure.schema_version !== "2.0" || closure.source !== "package-lock.json#packages"
    || closure.materialization !== "npm-ci-omit-dev-optional-ignore-scripts"
    || closure.policy?.roots !== "package.dependencies" || closure.policy?.transitive !== "dependencies"
    || closure.policy?.optional_dependencies !== "excluded" || closure.policy?.peer_dependencies !== "excluded") {
  throw new Error("Codex required runtime closure policy is not explicit and lockfile-bound");
}
const packageByPath = new Map(closure.packages.map((item) => [item.path, item]));
function resolveLocked(fromPath, name) {
  let current = fromPath;
  for (;;) {
    const candidate = current ? `${current}/node_modules/${name}` : name;
    if (lock.packages[`node_modules/${candidate}`]) return candidate;
    const marker = current.lastIndexOf("/node_modules/");
    if (marker < 0) return lock.packages[`node_modules/${name}`] ? name : null;
    current = current.slice(0, marker);
  }
}
const pending = Object.keys(source.dependencies ?? {}).sort().map((name) => ({ fromPath: "", name }));
const expected = new Set();
while (pending.length) {
  const { fromPath, name } = pending.shift();
  const dependencyPath = resolveLocked(fromPath, name);
  if (!dependencyPath) throw new Error(`package-lock.json cannot resolve ${name} from ${fromPath || "root"}`);
  if (expected.has(dependencyPath)) continue;
  expected.add(dependencyPath);
  const lockEntry = lock.packages[`node_modules/${dependencyPath}`];
  for (const child of Object.keys(lockEntry.dependencies ?? {}).sort()) {
    pending.push({ fromPath: dependencyPath, name: child });
  }
}
if (expected.size !== packageByPath.size || [...expected].some((dependencyPath) => !packageByPath.has(dependencyPath))) {
  throw new Error("Codex runtime dependency manifest does not exactly cover the required lockfile topology");
}
for (const [dependencyPath, item] of packageByPath) {
  const lockEntry = lock.packages[`node_modules/${dependencyPath}`];
  const expectedEdges = Object.keys(lockEntry?.dependencies ?? {}).sort().map((name) => ({
    name,
    path: resolveLocked(dependencyPath, name),
  }));
  if (!lockEntry || item.lock_path !== `node_modules/${dependencyPath}` || item.version !== lockEntry.version
      || item.integrity !== lockEntry.integrity || JSON.stringify(item.dependencies) !== JSON.stringify(expectedEdges)
      || !Array.isArray(item.files) || item.files.length === 0) {
    throw new Error(`Codex runtime dependency ${dependencyPath} is not version/integrity/file bound to package-lock.json`);
  }
}
const expectedRootEdges = Object.keys(source.dependencies ?? {}).sort().map((name) => ({ name, path: resolveLocked("", name) }));
if (JSON.stringify(closure.root_dependencies) !== JSON.stringify(expectedRootEdges)) {
  throw new Error("Codex runtime dependency root edges do not match package-lock.json");
}
NODE
then
  _pass "only Codex carries an exact lockfile-bound required dependency topology"
else
  _fail "runtime root package or Codex dependency closure boundary is invalid"
fi

if [[ -d "$DIST_DIR/codex/.agents/skills/plan-work" && ! -e "$DIST_DIR/codex/.codex/skills" ]]; then
  _pass "Codex exports portable skills only in the universal .agents catalog"
else
  _fail "Codex portable skills are not rooted exclusively at .agents/skills"
fi

if [[ ! -e "$DIST_DIR/codex/AGENTS.md" ]] \
  && grep -q 'Generated from the canonical source' "$DIST_DIR/codex/README.md" \
  && grep -q '## Exported agents' "$DIST_DIR/codex/README.md" \
  && grep -q '`tool-worker`' "$DIST_DIR/codex/README.md" \
  && ! grep -q 'Universal Agent Bundle (Codex)' "$DIST_DIR/codex/README.md"; then
  _pass "Codex provenance and agent inventory are documentation, not global instructions"
else
  _fail "Codex bundle still exposes generated global instructions or lost README discovery metadata"
fi

echo ""
echo "--- Documentation and Instruction Discovery Contract ---"
# Keep this table aligned with the supported-runtime capability policy.  A dash
# means the harness has no bundle-owned repository instruction file.
while IFS='|' read -r runtime bundle_dir instruction_rel; do
  readme="$DIST_DIR/$bundle_dir/README.md"
  if [[ -f "$readme" ]] \
    && grep -q 'Generated from the canonical source' "$readme" \
    && grep -q '## Exported agents' "$readme" \
    && grep -q '`tool-worker`' "$readme"; then
    _pass "$runtime keeps provenance and the exported-agent inventory in README.md"
  else
    _fail "$runtime README.md is missing canonical provenance or exported-agent inventory"
  fi

  if [[ "$instruction_rel" == "-" ]]; then
    if [[ ! -e "$DIST_DIR/$bundle_dir/AGENTS.md" && ! -e "$DIST_DIR/$bundle_dir/CLAUDE.md" ]]; then
      _pass "$runtime does not publish a repository instruction surface"
    else
      _fail "$runtime publishes an instruction file despite declaring no discovery surface"
    fi
    continue
  fi

  instruction="$DIST_DIR/$bundle_dir/$instruction_rel"
  if [[ -f "$instruction" ]]; then
    _pass "$runtime publishes concise guidance on $instruction_rel"
  else
    _fail "$runtime is missing its $instruction_rel discovery surface"
    continue
  fi

  if ! grep -Eq 'Treat the repo root as the source of truth|regenerate the bundle|were copied from the canonical source|Kiro-only hook wiring was stripped|## Exported Agents|## Exported agents' "$instruction" \
    && [[ "$(grep -Ec '^- `tool-' "$instruction" || true)" -eq 0 ]]; then
    _pass "$runtime instructions exclude maintainer prose and the exported-agent catalog"
  else
    _fail "$runtime instructions contain maintainer provenance, copied-directory notes, Kiro stripping notes, or a full agent catalog"
  fi
done <<'MATRIX'
Base|base|AGENTS.md
Kiro|kiro|AGENTS.md
Claude Code|claude-code|CLAUDE.md
Codex|codex|-
OpenCode|opencode|AGENTS.md
pi|pi|AGENTS.md
MATRIX

if node - "$ROOT_DIR/src/tools/build-universal-bundles.ts" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
for (const runtime of ["base", "kiro", "claude-code", "codex", "opencode", "pi"]) {
  if (!source.includes(`\"${runtime}\"`)) throw new Error(`shared capability policy missing ${runtime}`);
}
for (const required of ["BUNDLE_CAPABILITIES", "renderBundleReadme", "renderOperationalInstructions", "installScript"]) {
  if (!source.includes(required)) throw new Error(`shared bundle policy missing ${required}`);
}
if (source.includes("exportRootAgentsMd")) throw new Error("legacy combined provenance/instruction renderer remains");

const builders = source.match(/function build(?:Base|Kiro|ClaudeCode|Codex|Opencode|Pi)\([^]*?(?=\nfunction |\nexport |\nmain\()/g) || [];
if (builders.length !== 6) throw new Error(`expected six runtime builders, found ${builders.length}`);
for (const builder of builders) {
  if (!builder.includes("BUNDLE_CAPABILITIES")) throw new Error("runtime builder does not select shared capability data");
  if (!builder.includes("installScript(")) throw new Error("runtime builder bypasses the shared installer generator");
  if (/AGENTS\.md|CLAUDE\.md/.test(builder)) throw new Error("runtime builder contains a local instruction-file branch");
}
NODE
then
  _pass "all runtime builders select shared capabilities, renderers, and installer policy without local instruction branches"
else
  _fail "runtime bundle policy is duplicated or bypasses shared capabilities/renderers/installer preservation"
fi

if (cd "$ROOT_DIR" && node scripts/audit-codex-legacy-agents.js packaging/codex-legacy-agents-fingerprints.json >/tmp/codex-legacy-agents-audit.txt 2>&1) \
  && grep -q 'Audited 14 seed-capable releases; 1 unique payload(s); gaps=0' /tmp/codex-legacy-agents-audit.txt; then
  _pass "Codex legacy fingerprint catalog independently covers all seed-capable release tags"
else
  _fail "Codex legacy fingerprint catalog is incomplete, stale, or not byte-reproducible"
fi

if node - "$ROOT_DIR/scripts/classify-codex-legacy-agents.js" <<'NODE'
const fs = require("node:fs");
const source = fs.readFileSync(process.argv[2], "utf8");
for (const forbidden of ["renameSync", "unlinkSync", "writeFileSync", "copyFileSync", "mkdirSync", "chmodSync", "MIGRATION_TEST", "--apply", "quarantine", "mv --", "rm --", "cp --"]) {
  if (source.includes(forbidden)) throw new Error(`production classifier contains destructive/test path: ${forbidden}`);
}
for (const required of ["lstatSync", "openSync", "O_RDONLY", "O_NOFOLLOW", "fstatSync", "readFileSync(fd)", "createHash", "manual remediation checklist", "shellQuote"]) {
  if (!source.includes(required)) throw new Error(`production classifier missing read-only behavior: ${required}`);
}
NODE
then
  _pass "Codex legacy classifier is read-only and exposes no production apply or test hooks"
else
  _fail "Codex legacy classifier contains mutation/apply/test-hook behavior"
fi

if node - "$DIST_DIR/codex/.agents/skills" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const pattern = /(?:^|[`("'\s])(context\/contracts\/[A-Za-z0-9._/-]+\.md)(?=$|[`),"'\s])/gm;
for (const name of fs.readdirSync(root)) {
  const skill = path.join(root, name);
  const file = path.join(skill, "SKILL.md");
  if (!fs.existsSync(file)) continue;
  for (const match of fs.readFileSync(file, "utf8").matchAll(pattern)) {
    const resolved = path.resolve(skill, match[1]);
    if (!resolved.startsWith(`${path.resolve(skill)}${path.sep}`) || !fs.existsSync(resolved)) throw new Error(`${name}: ${match[1]}`);
  }
}
NODE
then
  _pass "Codex skill-local instruction resources resolve inside each package"
else
  _fail "Codex skill-local instruction resource closure failed"
fi

MISSING_SKILL_DIR="$ROOT_DIR/${SKILLS_SEGMENT:-skills}/zzz-missing-resource-probe"
MISSING_CONTRACT="${CONTEXT_SEGMENT:-context}/contracts/definitely-missing.md"
mkdir -p "$MISSING_SKILL_DIR"
printf '%s\n' '# Probe' '' "Read \`$MISSING_CONTRACT\`." > "$MISSING_SKILL_DIR/SKILL.md"
if (cd "$ROOT_DIR" && npm run build:bundles >/tmp/missing-skill-resource.stdout 2>/tmp/missing-skill-resource.stderr); then
  _fail "bundle generation accepted a missing skill instruction resource"
else
  if rg -q "skill 'zzz-missing-resource-probe': missing local resource '$MISSING_CONTRACT'" /tmp/missing-skill-resource.stderr; then
    _pass "bundle generation rejects missing skill resources with actionable diagnostics"
  else
    _fail "missing skill resource failure did not name its skill and path"
  fi
fi
rm -rf "$MISSING_SKILL_DIR"
(cd "$ROOT_DIR" && npm run build:bundles >/dev/null)

source_agents=$(find "$ROOT_DIR/agents" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')
codex_excluded_agents=$(node - "$ROOT_DIR/packaging/manifest.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
console.log((data.codex?.excluded_agents || []).length);
NODE
)
expected_codex_agents=$((source_agents - codex_excluded_agents))
kiro_agents=$(find "$DIST_DIR/kiro/agents" -maxdepth 1 -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
claude_agents=$(find "$DIST_DIR/claude-code/.claude/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
codex_agents=$(find "$DIST_DIR/codex/.codex/agents" -maxdepth 1 -name '*.toml' 2>/dev/null | wc -l | tr -d ' ')

[[ "$kiro_agents" == "$source_agents" ]] && _pass "Kiro agent count matches source ($kiro_agents)" || _fail "Kiro agent count mismatch: source=$source_agents dist=$kiro_agents"
[[ "$claude_agents" == "$source_agents" ]] && _pass "Claude agent count matches source ($claude_agents)" || _fail "Claude agent count mismatch: source=$source_agents dist=$claude_agents"
[[ "$codex_agents" == "$expected_codex_agents" ]] && _pass "Codex agent count matches source minus manifest exclusions ($codex_agents)" || _fail "Codex agent count mismatch: expected=$expected_codex_agents dist=$codex_agents"
opencode_agents=$(find "$DIST_DIR/opencode/.opencode/agents" -maxdepth 1 -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[[ "$opencode_agents" == "$source_agents" ]] && _pass "opencode agent count matches source ($opencode_agents)" || _fail "opencode agent count mismatch: source=$source_agents dist=$opencode_agents"

echo ""
echo "--- Kiro JSON ---"
if node - "$DIST_DIR/kiro/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".json"))) {
  const data = JSON.parse(fs.readFileSync(path.join(process.argv[2], name), "utf8"));
  for (const key of ["name", "description", "prompt", "model"]) {
    if (!(key in data)) throw new Error(`${name}: missing ${key}`);
  }
}
console.log("ok");
NODE
then
  _pass "Kiro agent JSON parses with required fields"
else
  _fail "Kiro agent JSON parse/shape check failed"
fi

echo ""
echo "--- Claude Export Shape ---"
if node - "$DIST_DIR/claude-code/.claude/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const required = new Set(["name", "description", "tools", "model"]);
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".md"))) {
  const text = fs.readFileSync(path.join(process.argv[2], name), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${name}: missing frontmatter start`);
  const parts = text.split("\n---\n");
  if (parts.length < 2) throw new Error(`${name}: missing frontmatter end`);
  const keys = new Set(parts[0].replace("---\n", "").split(/\r?\n/).filter((line) => line.includes(":")).map((line) => line.split(":", 1)[0].trim()));
  const missing = [...required].filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`${name}: missing frontmatter keys ${missing.join(", ")}`);
  if (!parts.slice(1).join("\n---\n").trim()) throw new Error(`${name}: empty body`);
}
console.log("ok");
NODE
then
  _pass "Claude agent markdown has valid frontmatter/body shape"
else
  _fail "Claude agent markdown shape check failed"
fi

if node - "$DIST_DIR/claude-code/.claude/settings.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const statusLine = data.statusLine || {};
if (statusLine.type !== "command" || !String(statusLine.command || "").includes("flow-agents-statusline.js")) throw new Error("Claude statusLine command missing Flow Agents statusline");
if (data.permissions?.defaultMode !== "auto") throw new Error("Claude permissions.defaultMode should default to auto");
if (data.skipDangerousModePermissionPrompt !== true) throw new Error("Claude dangerous-mode prompt skip fallback should be enabled");
const hooks = data.hooks || {};
const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];
const missing = required.filter((event) => !(event in hooks));
if (missing.length) throw new Error(`missing Claude hook events: ${missing.join(", ")}`);
for (const event of required) {
  if (!(hooks[event] || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-telemetry-hook.js")))) throw new Error(`${event} telemetry hook missing`);
}
if (!(hooks.Stop || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-hook-adapter.js") && String(hook.command || "").includes("stop-goal-fit.js")))) throw new Error("Stop goal-fit policy hook missing");
if (!(hooks.UserPromptSubmit || []).some((group) => [undefined, null, "*"].includes(group.matcher) && (group.hooks || []).some((hook) => String(hook.command || "").includes("claude-hook-adapter.js") && String(hook.command || "").includes("workflow-steering.js")))) throw new Error("prompt-submit workflow-steering policy hook missing");
console.log("ok");
NODE
then
  _pass "Claude settings include auto permissions, dangerous prompt fallback, statusLine, telemetry, and policy hooks"
else
  _fail "Claude settings auto permissions, dangerous prompt fallback, statusLine, or telemetry/policy hooks missing"
fi

echo ""
echo "--- Codex Export Shape ---"
if node - "$DIST_DIR/codex/.codex/config.toml" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (text.includes("codex_hooks")) throw new Error("deprecated codex_hooks feature flag exported");
if (!text.includes("hooks = true")) throw new Error("current hooks feature flag missing");
if (!text.includes('approvals_reviewer = "auto_review"')) throw new Error("top-level auto-review approval reviewer missing");
if (!text.includes("[tui]") || !text.includes('status_line = ["model-with-reasoning", "project-name", "git-branch", "task-progress", "context-remaining", "run-state"]')) throw new Error("Codex TUI status_line missing workflow progress items");
if (text.includes("[profiles.") || text.includes("\nprofile = ")) throw new Error("Codex base config contains legacy profile config");
console.log("ok");
NODE
then
  _pass "Codex config uses profile-v2 base shape, current hooks feature flag, auto-review reviewer, and status line"
else
  _fail "Codex config profile-v2 shape, hook feature flag, auto-review reviewer, or status line is stale"
fi

if node - "$DIST_DIR/codex/.codex" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const expected = ["builder", "personal"];
const missingFiles = expected.filter((name) => !fs.existsSync(path.join(root, `${name}.config.toml`)));
if (missingFiles.length) throw new Error(`profile-v2 config files missing: ${missingFiles.join(", ")}`);
const extra = fs.readdirSync(root).filter((name) => name.endsWith(".config.toml") && !expected.includes(name.replace(/\.config\.toml$/, "")));
if (extra.length) throw new Error(`unexpected generated profile files: ${extra.join(", ")}`);
const missing = expected.filter((name) => !fs.readFileSync(path.join(root, `${name}.config.toml`), "utf8").includes('approvals_reviewer = "auto_review"'));
if (missing.length) throw new Error(`profile auto-review approval reviewer missing: ${missing.join(", ")}`);
const personal = fs.readFileSync(path.join(root, "personal.config.toml"), "utf8");
if (!personal.includes("Flow Agents Personal mode") || !personal.includes("knowledge-capture")) throw new Error("personal profile does not carry knowledge-work instructions");
console.log("ok");
NODE
then
  _pass "Codex profile-v2 files select auto-review reviewer"
else
  _fail "Codex profile-v2 auto-review reviewer check failed"
fi

if node - "$DIST_DIR/codex/.codex/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const required = ['name = "', 'description = "', 'model = "', 'model_reasoning_effort = "', 'developer_instructions = '];
for (const name of fs.readdirSync(root).filter((file) => file.endsWith(".toml"))) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  for (const needle of required) if (!text.includes(needle)) throw new Error(`${name}: missing ${needle}`);
}
console.log("ok");
NODE
then
  _pass "Codex agent TOML has required fields"
else
  _fail "Codex agent TOML required-field check failed"
fi

if node - "$DIST_DIR/codex/.codex/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
function stringAssignment(text, key, name) {
  const matches = [...text.matchAll(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "gm"))];
  if (matches.length !== 1) throw new Error(`${name}: expected exactly one ${key} assignment, found ${matches.length}`);
  return matches[0][1];
}
const expected = {
  "tool-planner.toml": ["gpt-5.6-sol", "high"],
  "tool-worker.toml": ["gpt-5.6-terra", "high"],
  "tool-code-reviewer.toml": ["gpt-5.6-sol", "high"],
  "tool-security-reviewer.toml": ["gpt-5.6-sol", "high"],
  "tool-verifier.toml": ["gpt-5.6-sol", "high"],
};
for (const [name, [model, effort]] of Object.entries(expected)) {
  const text = fs.readFileSync(path.join(root, name), "utf8");
  if (stringAssignment(text, "model", name) !== model) throw new Error(`${name}: expected model ${model}`);
  if (stringAssignment(text, "model_reasoning_effort", name) !== effort) throw new Error(`${name}: expected reasoning ${effort}`);
}
const fallback = fs.readFileSync(path.join(root, "tool-playwright.toml"), "utf8");
if (stringAssignment(fallback, "model", "tool-playwright.toml") !== "gpt-5.5" ||
    stringAssignment(fallback, "model_reasoning_effort", "tool-playwright.toml") !== "low") {
  throw new Error("unmapped Codex agent no longer uses family fallback");
}
console.log("ok");
NODE
then
  _pass "Codex Builder specialist roles use deterministic 5.6 models and unmapped agents retain family fallback"
else
  _fail "Codex Builder specialist role routing is missing, stale, or bypasses family fallback"
fi

if node - "$DIST_DIR/codex/.codex/hooks.json" <<'NODE'
const fs = require("node:fs");
const hooks = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).hooks || {};
const required = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse", "Stop"];
const missing = required.filter((event) => !(event in hooks));
if (missing.length) throw new Error(`missing Codex hook events: ${missing.join(", ")}`);
if (!(hooks.PermissionRequest || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("telemetry.sh")))) throw new Error("PermissionRequest telemetry hook missing");
if (!(hooks.Stop || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || "").includes("codex-hook-adapter.js") && String(hook.command || "").includes("stop-goal-fit.js")))) throw new Error("Stop goal-fit policy hook missing");
if (!(hooks.UserPromptSubmit || []).some((group) => [undefined, null, "*"].includes(group.matcher) && (group.hooks || []).some((hook) => String(hook.command || "").includes("codex-hook-adapter.js") && String(hook.command || "").includes("workflow-steering.js")))) throw new Error("prompt-submit workflow-steering policy hook missing");
for (const groups of Object.values(hooks)) {
  for (const group of groups || []) {
    for (const hook of group.hooks || []) {
      const command = String(hook.command || "");
      if (!command.includes('root="${CODEX_HOME:-}"')) throw new Error(`Codex hook does not prefer CODEX_HOME: ${command}`);
      if (command.includes("'root=$(git rev-parse --show-toplevel")) throw new Error(`Codex hook uses stale repo-root-only resolver: ${command}`);
    }
  }
}
console.log("ok");
NODE
then
  _pass "Codex hooks cover telemetry and policy lifecycle events with CODEX_HOME root resolution"
else
  _fail "Codex hooks missing telemetry/policy lifecycle coverage or CODEX_HOME root resolution"
fi

echo ""
echo "--- opencode Export Shape ---"
if node - "$DIST_DIR/opencode/.opencode/agents" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const required = new Set(["description", "mode", "model"]);
const validModes = new Set(["subagent", "primary", "all"]);
for (const name of fs.readdirSync(process.argv[2]).filter((file) => file.endsWith(".md"))) {
  const text = fs.readFileSync(path.join(process.argv[2], name), "utf8");
  if (!text.startsWith("---\n")) throw new Error(`${name}: missing frontmatter start`);
  const parts = text.split("\n---\n");
  if (parts.length < 2) throw new Error(`${name}: missing frontmatter end`);
  const fmLines = parts[0].replace("---\n", "").split(/\r?\n/).filter((line) => line.includes(":"));
  const keys = new Set(fmLines.map((line) => line.split(":", 1)[0].trim()));
  const missing = [...required].filter((key) => !keys.has(key));
  if (missing.length) throw new Error(`${name}: missing frontmatter keys ${missing.join(", ")}`);
  const modeMatch = fmLines.find((line) => line.trim().startsWith("mode:"));
  if (modeMatch) {
    const mode = modeMatch.split(":", 2)[1].trim();
    if (!validModes.has(mode)) throw new Error(`${name}: invalid mode value: ${mode}`);
  }
  if (!parts.slice(1).join("\n---\n").trim()) throw new Error(`${name}: empty body`);
}
console.log("ok");
NODE
then
  _pass "opencode agent markdown has valid YAML frontmatter with description, mode, model"
else
  _fail "opencode agent markdown frontmatter/shape check failed"
fi

if [[ -f "$DIST_DIR/opencode/.opencode/plugins/flow-agents.js" ]]; then
  _pass "opencode bundle includes Flow Agents plugin"
else
  _fail "opencode bundle missing .opencode/plugins/flow-agents.js"
fi

if [[ -f "$DIST_DIR/opencode/opencode.json" ]]; then
  if node - "$DIST_DIR/opencode/opencode.json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!data || typeof data !== "object") throw new Error("opencode.json must be an object");
// opencode's config schema rejects non-array `instructions` and aborts
// startup (caught by live acceptance smoke 2026-06-11). Pin the constraint.
if ("instructions" in data && !Array.isArray(data.instructions)) {
  throw new Error("opencode.json instructions must be an array of file paths when present");
}
console.log("ok");
NODE
  then
    _pass "opencode.json is valid JSON and schema-safe (instructions array-or-absent)"
  else
    _fail "opencode.json is invalid or violates opencode config schema"
  fi
else
  _fail "opencode bundle missing opencode.json"
fi

# Root AGENTS.md carries a hand-maintained "Repository Conventions" section
# (commit/release rules for agents working in THIS repo). The rest of the
# file mirrors generated bundle output; this pin prevents a regeneration
# sync from silently dropping the repo-specific section.
if grep -q "## Repository Conventions (source repo only)" "$ROOT_DIR/AGENTS.md" 2>/dev/null && grep -q "release-please" "$ROOT_DIR/AGENTS.md" 2>/dev/null; then
  _pass "root AGENTS.md retains the Repository Conventions section"
else
  _fail "root AGENTS.md is missing the Repository Conventions section (regeneration clobbered it?)"
fi

# Generated hook artifacts must PARSE in their host language. The pi live
# smoke (2026-06-11) caught the generator emitting an unterminated string
# (template-literal escaping) that pi's loader rejected at startup.
if node --check "$DIST_DIR/opencode/.opencode/plugins/flow-agents.js" 2>/dev/null; then
  _pass "generated opencode plugin parses as JavaScript"
else
  _fail "generated opencode plugin has a JavaScript syntax error"
fi

# Semantic errors (TS2xxx: unresolved modules/types) are expected without the
# host's node_modules; only syntax-class errors (TS1xxx) mean a broken artifact.
PI_TS_SYNTAX_ERRORS=$(npx tsc --ignoreConfig --noEmit --noResolve --skipLibCheck --target esnext --module esnext \
    "$DIST_DIR/pi/.pi/extensions/flow-agents.ts" 2>&1 | grep -c "error TS1" || true)
if [[ "$PI_TS_SYNTAX_ERRORS" -eq 0 ]]; then
  _pass "generated pi extension parses as TypeScript (no TS1xxx syntax errors)"
else
  _fail "generated pi extension has $PI_TS_SYNTAX_ERRORS TypeScript syntax errors"
fi

if [[ -d "$DIST_DIR/opencode/.opencode/skills" ]] && [[ $(find "$DIST_DIR/opencode/.opencode/skills" -name "SKILL.md" | wc -l | tr -d ' ') -gt 0 ]]; then
  _pass "opencode bundle includes skills in .opencode/skills/"
else
  _fail "opencode bundle missing skills in .opencode/skills/"
fi

echo ""
echo "--- pi Export Shape ---"
if [[ -f "$DIST_DIR/pi/.pi/extensions/flow-agents.ts" ]]; then
  _pass "pi bundle includes Flow Agents extension"
else
  _fail "pi bundle missing .pi/extensions/flow-agents.ts"
fi

if [[ -d "$DIST_DIR/pi/.pi/skills" ]] && [[ $(find "$DIST_DIR/pi/.pi/skills" -name "SKILL.md" | wc -l | tr -d ' ') -gt 0 ]]; then
  _pass "pi bundle includes skills in .pi/skills/"
else
  _fail "pi bundle missing skills in .pi/skills/"
fi

if node - "$DIST_DIR/pi/.pi/extensions/flow-agents.ts" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (!text.includes("pi-hook-adapter.js")) throw new Error("pi extension does not reference pi-hook-adapter.js");
if (!text.includes("pi-telemetry-hook.js")) throw new Error("pi extension does not reference pi-telemetry-hook.js");
if (!text.includes("workflow-steering.js")) throw new Error("pi extension missing workflow-steering.js reference");
if (!text.includes("config-protection.js")) throw new Error("pi extension missing config-protection.js reference");
if (!text.includes("stop-goal-fit.js")) throw new Error("pi extension missing stop-goal-fit.js reference");
if (!text.includes("before_agent_start")) throw new Error("pi extension missing before_agent_start event handler");
if (!text.includes("tool_call")) throw new Error("pi extension missing tool_call event handler");
console.log("ok");
NODE
then
  _pass "pi extension references correct hook adapters and event handlers"
else
  _fail "pi extension is missing required hook adapter or event handler references"
fi

if node - "$DIST_DIR/opencode/.opencode/plugins/flow-agents.js" <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync(process.argv[2], "utf8");
if (!text.includes("opencode-hook-adapter.js")) throw new Error("opencode plugin does not reference opencode-hook-adapter.js");
if (!text.includes("opencode-telemetry-hook.js")) throw new Error("opencode plugin does not reference opencode-telemetry-hook.js");
if (!text.includes("workflow-steering.js")) throw new Error("opencode plugin missing workflow-steering.js reference");
if (!text.includes("config-protection.js")) throw new Error("opencode plugin missing config-protection.js reference");
if (!text.includes("stop-goal-fit.js")) throw new Error("opencode plugin missing stop-goal-fit.js reference");
if (!text.includes("session.created")) throw new Error("opencode plugin missing session.created event handler");
if (!text.includes("tool.execute.before")) throw new Error("opencode plugin missing tool.execute.before event handler");
console.log("ok");
NODE
then
  _pass "opencode plugin references correct hook adapters and event handlers"
else
  _fail "opencode plugin is missing required hook adapter or event handler references"
fi

echo ""
echo "--- Shared Task Dirs ---"
for dir in "$DIST_DIR/claude-code/.kontourai/flow-agents" "$DIST_DIR/codex/.kontourai/flow-agents" "$DIST_DIR/opencode/.kontourai/flow-agents" "$DIST_DIR/pi/.kontourai/flow-agents"; do
  if [[ -d "$dir" ]]; then
    _pass "$(realpath "$dir" 2>/dev/null || echo "$dir") exists"
  else
    _fail "$dir missing"
  fi
done

echo ""
echo "--- Portability Leaks ---"
if rg -n '/Users/[^/]+/\.flow-agents|~/\.flow-agents' "$DIST_DIR" --glob '!**/evals/**' >/tmp/universal-bundle-leaks.txt 2>/dev/null; then
  _fail "machine-local absolute paths leaked into dist (see /tmp/universal-bundle-leaks.txt)"
else
  _pass "no machine-local absolute paths leaked into dist"
fi

if rg -n '\.kiro/cli_todos/|\.ai/cli_todos/' "$DIST_DIR/claude-code" "$DIST_DIR/codex" --glob '!**/evals/**' >/tmp/universal-bundle-taskdir-leaks.txt 2>/dev/null; then
  _fail "non-Kiro bundles still reference legacy task dirs (see /tmp/universal-bundle-taskdir-leaks.txt)"
else
  _pass "non-Kiro bundles use Flow Agents task dir paths"
fi

echo ""
echo "--- Catalog ---"
if node - "$DIST_DIR/catalog.json" "$source_agents" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedAgents = Number(process.argv[3]);
if (data.source_root !== ".") throw new Error("catalog source_root should be '.'");
if ((data.agents || []).length !== expectedAgents) throw new Error("catalog agent count mismatch");
console.log("ok");
NODE
then
  _pass "catalog metadata is sane"
else
  _fail "catalog metadata check failed"
fi

# Block Reason Channel (#100): the generated opencode/pi adapters must carry the
# policy reason into their block path so the model learns why it was blocked.
# claude/codex deny translation is covered in test_hook_category_behaviors.sh.
BUILDER_SRC="$ROOT_DIR/src/tools/build-universal-bundles.ts"
if grep -q "throw new Error(policyResult.reason" "$BUILDER_SRC"; then
  _pass "opencode adapter surfaces the block reason to the model (thrown error)"
else
  _fail "opencode adapter block path dropped the policy reason"
fi
if grep -q "reason: result.reason" "$BUILDER_SRC"; then
  _pass "pi adapter surfaces the block reason to the model (block result reason)"
else
  _fail "pi adapter block path dropped the policy reason"
fi

echo ""
echo "--- Skill collision detector (AC6) ---"
# Positive: the real skill set across skills/ and kits/*/kit.json builds with no collision.
if (cd "$ROOT_DIR" && FLOW_AGENTS_DIST_DIR="$(mktemp -d)" node build/src/cli.js build-bundles) >/tmp/universal-bundle-collision-clean.txt 2>&1; then
  _pass "build succeeds with the current (collision-free) skill set"
else
  _fail "clean build unexpectedly failed"
  sed -n '1,60p' /tmp/universal-bundle-collision-clean.txt
fi

# Negative: a synthetic kit re-using an existing skill directory name (deliver) must FAIL
# the build with a diagnostic naming both source kits.
COLLIDE_KIT="$ROOT_DIR/kits/zzz-collision-eval-probe"
rm -rf "$COLLIDE_KIT"
mkdir -p "$COLLIDE_KIT/skills/deliver"
cat > "$COLLIDE_KIT/kit.json" <<'KITJSON'
{
  "schema_version": "1.0",
  "id": "zzz-collision-eval-probe",
  "name": "Collision Eval Probe",
  "flows": [],
  "skills": [
    { "id": "zzz.deliver", "path": "skills/deliver/SKILL.md" }
  ]
}
KITJSON
printf '# collision probe skill\n' > "$COLLIDE_KIT/skills/deliver/SKILL.md"
if (cd "$ROOT_DIR" && FLOW_AGENTS_DIST_DIR="$(mktemp -d)" node build/src/cli.js build-bundles) >/tmp/universal-bundle-collision.txt 2>&1; then
  _fail "build should FAIL when two kits declare the same skill directory name"
else
  if grep -q "skill name collision" /tmp/universal-bundle-collision.txt \
    && grep -q "kits/builder" /tmp/universal-bundle-collision.txt \
    && grep -q "zzz-collision-eval-probe" /tmp/universal-bundle-collision.txt; then
    _pass "build fails with a clear collision diagnostic naming both source kits"
  else
    _fail "collision diagnostic missing expected text"
    sed -n '1,60p' /tmp/universal-bundle-collision.txt
  fi
fi
rm -rf "$COLLIDE_KIT"

echo ""
echo "==========================="
total=$((pass + fail))
echo "Results: ${pass}/${total} passed, ${fail} failed"
[[ "$fail" -gt 0 ]] && exit 1
exit 0
