#!/usr/bin/env node
/**
 * install-merge.js — Merge-aware installer for flow-agents config files.
 *
 * Usage (CLI — full merge):
 *   node scripts/install-merge.js \
 *     --config <path-to-settings.json-or-hooks.json> \
 *     --managed-hooks <path-to-flow-agents-hooks-snippet.json> \
 *     --version <version-string> \
 *     --install-record <path-to-install.json> \
 *     --runtime <claude-code|codex|opencode|pi|kiro|base> \
 *     [--omit-managed-key <top-level-key>]...
 *
 * Usage (CLI — stamp only, no config merge):
 *   node scripts/install-merge.js \
 *     --stamp-only \
 *     --version <version-string> \
 *     --install-record <path-to-install.json> \
 *     --runtime <pi|kiro|base|opencode>
 *
 * Design (per install-merge-aware--plan-work.md):
 *   (a) Read dest JSON (or {} if absent).
 *   (b) STRIP any hook entry whose inner hooks' statusMessage matches a
 *       flow-agents marker (the COLLISION_MARKER strings from init.ts).
 *   (c) APPEND the current managed hook groups from the bundle.
 *   (d) Preserve ALL other keys (permissions, statusLine, user hooks, auth).
 *       Managed non-hook values are added only when absent or when replacing
 *       an existing Flow Agents-owned value. Conflicting user-owned values win
 *       and are reported to stderr.
 *   (e) Atomic write (write tmp + rename).
 *   (f) Write/update .flow-agents/install.json version stamp.
 *
 * Export: mergeSettings(existing, managed, options) — pure, testable.
 * The managed ownership region is identified purely by statusMessage markers
 * (cross-runtime, no top-level key needed in settings.json).
 */

"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");

// ─── Marker strings ───────────────────────────────────────────────────────────
// These statusMessage strings identify every flow-agents managed hook.
// They are the same strings used by COLLISION_MARKER in src/cli/init.ts and
// by exportClaudeSettings() / exportCodexHooks() in build-universal-bundles.ts.
const FA_MARKERS = [
  "Recording Flow Agents telemetry",
  "Running Flow Agents hook policy",
  "Capturing Flow Agents command evidence",
  // Cleanup tombstone: 3.4.2 installed this retired PreToolUse hook. Keep the
  // marker recognizable so upgrades remove it even though new bundles do not.
  "Enforcing Flow Agents projected action",
];

const FA_OWNERSHIP_MARKERS = [
  ...FA_MARKERS,
  "flow-agents",
  "Flow Agents",
];

function stableJson(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function valuesEqual(a, b) {
  return stableJson(a) === stableJson(b);
}

function valueContainsManagedMarker(value) {
  return FA_OWNERSHIP_MARKERS.some((marker) => stableJson(value).includes(marker));
}

function conflict(path, existingValue, managedValue) {
  return { path, existingValue, managedValue };
}

function emitConflict(onConflict, item) {
  if (typeof onConflict === "function") onConflict(item);
}

/**
 * Returns true if a single INNER hook object (one entry of a hook group's `hooks` array --
 * `{ type, command, timeout, statusMessage }`) is owned by flow-agents, by checking whether its
 * `statusMessage` contains one of the FA_MARKERS strings. This is the single source of truth for
 * "is this hook FA-owned" at entry granularity -- `isManagedHookGroup` below (whole-group,
 * consumed by mergeSettings' hooks step) and src/cli/uninstall.ts's entry-granular settings
 * stripping are both defined in terms of this function (uninstall.ts imports it directly), so
 * the two can never independently drift on which hooks count as FA-owned.
 *
 * @param {unknown} innerHook
 * @returns {boolean}
 */
function isManagedInnerHook(innerHook) {
  if (typeof innerHook !== "object" || innerHook === null) return false;
  const sm = typeof innerHook.statusMessage === "string" ? innerHook.statusMessage : "";
  return FA_MARKERS.some((marker) => sm.includes(marker));
}

/**
 * Returns true if a hook-group entry is owned by flow-agents.
 * A hook-group in Claude Code settings looks like:
 *   { hooks: [ { type, command, timeout, statusMessage } ] }
 * A hook-group in Codex hooks.json looks like:
 *   { hooks: [ { type, command, timeout, statusMessage } ] }
 *
 * We identify a managed group by checking whether ANY inner hook's
 * statusMessage contains one of the FA_MARKERS strings.
 *
 * @param {Record<string, unknown>} hookGroup
 * @returns {boolean}
 */
function isManagedHookGroup(hookGroup) {
  if (typeof hookGroup !== "object" || hookGroup === null) return false;
  const innerHooks = Array.isArray(hookGroup.hooks) ? hookGroup.hooks : [];
  return innerHooks.some((innerHook) => isManagedInnerHook(innerHook));
}

/**
 * mergeArrayUnion — union two arrays preserving order, de-duped (string or JSON key).
 * @param {unknown} a @param {unknown} b @returns {unknown[]}
 */
function mergeArrayUnion(a, b) {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * mergePermissions — deep-merge the `permissions` block so flow-agents only ADDS
 * its required entries and never clobbers the user's customizations (#117):
 *   - union the user's + managed `allow`/`deny`/`ask` rule lists (de-duped),
 *   - preserve the user's `defaultMode` when set (only adopt managed's if unset),
 *   - keep user-only sub-keys; overlay other managed scalar sub-keys.
 * @param {unknown} existingPerms @param {unknown} managedPerms
 * @returns {Record<string, unknown>}
 */
function mergePermissions(existingPerms, managedPerms, options = {}) {
  const e = existingPerms && typeof existingPerms === "object" ? existingPerms : {};
  const m = managedPerms && typeof managedPerms === "object" ? managedPerms : {};
  const out = Object.assign({}, e);
  for (const listKey of ["allow", "deny", "ask"]) {
    if (Array.isArray(e[listKey]) || Array.isArray(m[listKey])) {
      out[listKey] = mergeArrayUnion(e[listKey], m[listKey]);
    }
  }
  for (const [key, value] of Object.entries(m)) {
    if (["allow", "deny", "ask"].includes(key)) continue;
    if (!(key in e)) {
      out[key] = value;
      continue;
    }
    if (valuesEqual(e[key], value) || valueContainsManagedMarker(e[key])) {
      out[key] = value;
      continue;
    }
    out[key] = e[key];
    emitConflict(options.onConflict, conflict(`permissions.${key}`, e[key], value));
  }
  return out;
}

/**
 * mergeSettings — pure merge function (no I/O).
 *
 * Given:
 *   existing  — the current dest settings object (e.g. from settings.json)
 *   managed   — the flow-agents generated settings (e.g. from bundle .claude/settings.json)
 *
 * Returns a new object with:
 *   - All keys from `existing` preserved (permissions, statusLine, auth, etc.)
 *   - Managed keys added when absent, or updated only when the existing value
 *     is already Flow Agents-owned.
 *   - User-owned managed-key conflicts preserved from `existing` and surfaced
 *     through `options.onConflict`.
 *   - For the `hooks` key: user-owned hook groups (non-FA) survive; FA groups are
 *     replaced with the current managed set from `managed`.
 *
 * Strategy:
 *   1. Start with a shallow copy of `existing` (preserves all user keys).
 *   2. Add or update Flow Agents-owned non-hooks keys from `managed`; preserve
 *      user-owned conflicting values and report conflicts.
 *   3. For `hooks`: iterate each event key from both existing and managed;
 *      keep user (non-FA) groups from existing, append the current FA groups
 *      from managed.
 *
 * @param {Record<string, unknown>} existing
 * @param {Record<string, unknown>} managed
 * @returns {Record<string, unknown>}
 */
function mergeSettings(existing, managed, options = {}) {
  // 1. Start with all existing keys (preserves user-owned data).
  const result = Object.assign({}, existing);

  // 2. Add non-hooks keys from managed without overwriting user-owned values.
  //    If a key is absent, add the managed default. If the existing value is
  //    already Flow Agents-owned (for example the generated statusLine command),
  //    replace it with the current managed value. Otherwise preserve the user's
  //    value and surface a conflict so the user can decide.
  for (const [key, value] of Object.entries(managed)) {
    if (key === "hooks") continue;
    if (key === "permissions") {
      result.permissions = mergePermissions(existing.permissions, value, options);
    } else if (!(key in existing)) {
      result[key] = value;
    } else if (valuesEqual(existing[key], value) || valueContainsManagedMarker(existing[key])) {
      result[key] = value;
    } else {
      result[key] = existing[key];
      emitConflict(options.onConflict, conflict(key, existing[key], value));
    }
  }

  // 3. Merge hooks: strip FA groups from existing, append current FA groups.
  const existingHooks =
    typeof existing.hooks === "object" && existing.hooks !== null
      ? (existing.hooks)
      : {};
  const managedHooks =
    typeof managed.hooks === "object" && managed.hooks !== null
      ? (managed.hooks)
      : {};

  // Collect all event keys from both sides.
  const allEventKeys = new Set([
    ...Object.keys(existingHooks),
    ...Object.keys(managedHooks),
  ]);

  const mergedHooks = {};
  for (const eventKey of allEventKeys) {
    const existingGroups = Array.isArray(existingHooks[eventKey])
      ? existingHooks[eventKey]
      : [];
    const managedGroups = Array.isArray(managedHooks[eventKey])
      ? managedHooks[eventKey]
      : [];

    // Keep user-owned content from existing groups at ENTRY granularity, not group
    // granularity: the Claude Code settings schema allows multiple entries in one group's
    // `hooks` array, and nothing prevents a user (or another tool) appending its own hook into
    // a group flow-agents also writes into. Stripping the whole group the moment ANY inner
    // entry matched an FA marker silently deleted that co-located user hook on every ordinary
    // re-install/upgrade (#findings: uninstall r1 HIGH, r2 delta HIGH -- this is the same
    // classifier, now fixed at its one source instead of only on the uninstall path). A group
    // survives, with every other group-level field (`matcher`, etc.) preserved via the spread,
    // whenever at least one of its inner hooks is not FA-owned; it is dropped entirely only when
    // every inner hook was FA-owned, exactly as before.
    const userGroups = [];
    for (const group of existingGroups) {
      if (typeof group !== "object" || group === null || !Array.isArray(group.hooks)) {
        if (!isManagedHookGroup(group)) userGroups.push(group);
        continue;
      }
      const keptInner = group.hooks.filter((hook) => !isManagedInnerHook(hook));
      if (keptInner.length > 0) userGroups.push(Object.assign({}, group, { hooks: keptInner }));
    }

    // Append the new FA groups from managed (may be empty if event not in managed).
    mergedHooks[eventKey] = [...userGroups, ...managedGroups];

    // Drop empty event keys (only user groups existed and were zero — unlikely
    // but defensive: remove keys with empty arrays to keep JSON clean).
    if (mergedHooks[eventKey].length === 0) {
      delete mergedHooks[eventKey];
    }
  }

  // Only write the hooks key if at least one side actually had a hooks key,
  // OR if the merged result is non-empty. This prevents injecting a spurious
  // empty "hooks": {} into configs that have no hooks (e.g. opencode.json).
  const eitherHadHooks = "hooks" in existing || "hooks" in managed;
  if (eitherHadHooks || Object.keys(mergedHooks).length > 0) {
    result.hooks = mergedHooks;
  }
  return result;
}

/**
 * atomicWriteJson — write JSON to a file atomically (tmp + rename).
 *
 * @param {string} filePath
 * @param {unknown} data
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, filePath);
}

/**
 * writeInstallRecord — write/update .flow-agents/install.json.
 *
 * @param {string} installRecordPath
 * @param {string} version
 * @param {string} runtime
 */
function captureConfigPremerge(configPath) {
  if (!fs.existsSync(configPath)) return { schema_version: "1.0", existed: false, bytes_base64: "", parsed: {}, config_path: path.resolve(configPath) };
  const bytes = fs.readFileSync(configPath);
  return {
    schema_version: "1.0",
    existed: true,
    bytes_base64: bytes.toString("base64"),
    parsed: JSON.parse(bytes.toString("utf8")),
    config_path: path.resolve(configPath),
  };
}

function normalizeV1ConfigPremergeSnapshot(value, runtime, configPath) {
  if (!value || typeof value !== "object" || value.schema_version !== "1.0") return value;
  // Released v1 records predate snapshot-local identity. Their enclosing install
  // record and the config path being operated on were the identity contract.
  // Preserve explicit fields so a contradictory record still fails validation.
  return {
    ...value,
    ...(value.runtime === undefined ? { runtime } : {}),
    ...(value.config_path === undefined && configPath ? { config_path: path.resolve(configPath) } : {}),
  };
}

function validConfigPremergeSnapshot(value, runtime, configPath) {
  value = normalizeV1ConfigPremergeSnapshot(value, runtime, configPath);
  if (!value || typeof value !== "object" || value.schema_version !== "1.0"
    || typeof value.existed !== "boolean" || typeof value.bytes_base64 !== "string"
    || typeof value.post_install_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.post_install_sha256)
    || typeof value.config_path !== "string" || value.runtime !== runtime
    || !value.parsed || typeof value.parsed !== "object" || Array.isArray(value.parsed)) return false;
  if (!value.existed) return value.bytes_base64 === "" && Object.keys(value.parsed).length === 0;
  try {
    const bytes = Buffer.from(value.bytes_base64, "base64");
    return bytes.toString("base64") === value.bytes_base64
      && JSON.stringify(JSON.parse(bytes.toString("utf8"))) === JSON.stringify(value.parsed);
  } catch { return false; }
}

function priorOrigin(installRecordPath, runtime, configPath) {
  if (!fs.existsSync(installRecordPath)) return { state: "absent" };
  try {
    const record = JSON.parse(fs.readFileSync(installRecordPath, "utf8"));
    if (record.runtime !== runtime) return { state: "invalid" };
    const premerge = record.config_premerge;
    if (premerge?.schema_version === "2.0") {
      if (!validConfigPremergeSnapshot(premerge.origin, runtime, configPath)) return { state: "invalid" };
      return { state: "valid", origin: normalizeV1ConfigPremergeSnapshot(premerge.origin, runtime, configPath) };
    }
    // Version 1 had one snapshot serving both purposes. It is the best available
    // lineage origin when upgrading; new records split the responsibilities.
    return validConfigPremergeSnapshot(premerge, runtime, configPath)
      ? { state: "valid", origin: normalizeV1ConfigPremergeSnapshot(premerge, runtime, configPath) }
      : { state: "invalid" };
  } catch { return { state: "invalid" }; }
}

function installedValues(configPath, merged, managed) {
  const hooks = [];
  for (const groups of Object.values(managed.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) if (group && Array.isArray(group.hooks)) hooks.push(...group.hooks);
  }
  const values = { hooks };
  if (valueContainsManagedMarker(merged.statusLine)) values.statusLine = merged.statusLine;
  if (Array.isArray(managed.instructions)) values.instructions = managed.instructions;
  return { [path.resolve(configPath)]: values };
}

/**
 * Return the original bytes only when config surgery fully restored the
 * pre-merge JSON value. Formatting is user data too, so a structural round
 * trip must not silently reformat a config that otherwise came back intact.
 */
function restoreConfigPremergeBytes(premerge, nextContent, currentBytes) {
  if (!premerge || premerge.schema_version !== "1.0") return null;
  if (!premerge.existed || typeof premerge.bytes_base64 !== "string") return null;
  if (typeof premerge.post_install_sha256 !== "string" || !Buffer.isBuffer(currentBytes)) return null;
  if (crypto.createHash("sha256").update(currentBytes).digest("hex") !== premerge.post_install_sha256) return null;
  if (!valuesEqual(premerge.parsed, nextContent)) return null;
  return Buffer.from(premerge.bytes_base64, "base64");
}

function stampConfigPremergePostInstallHash(premerge, configPath) {
  if (!premerge || typeof premerge !== "object") return premerge;
  return { ...premerge, post_install_sha256: crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex") };
}

function writeInstallRecord(installRecordPath, version, runtime, configPremerge, installed_values) {
  const record = {
    version,
    installedAt: new Date().toISOString(),
    runtime,
    ...(configPremerge ? { config_premerge: configPremerge } : {}),
    ...(installed_values ? { installed_values } : {}),
  };
  const dir = path.dirname(installRecordPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${installRecordPath}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, installRecordPath);
    fs.chmodSync(installRecordPath, 0o600);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * runMerge — perform the full merge (read, merge, write, stamp).
 *
 * `omitManagedKeys` drops top-level keys from the managed config BEFORE the merge, so the
 * install never writes them and `installedValues()` never records them as ours. It is the
 * mechanism behind `flow-agents init`'s default strip of the permissive Claude Code
 * permission keys (kontourai/flow-agents#1345): the bundle stays the dedicated-workspace
 * artifact, and a project install subtracts what a shared repository must not inherit.
 * Deliberately applied to `managed`, not to the merged result -- a key the USER already set
 * in their own settings file is theirs and must survive untouched.
 *
 * @param {{
 *   configPath: string,
 *   managedHooksPath: string,
 *   version: string,
 *   installRecordPath: string,
 *   runtime: string,
 *   omitManagedKeys?: string[],
 * }} opts
 */
function runMerge({ configPath, managedHooksPath, version, installRecordPath, runtime, omitManagedKeys = [] }) {
  // (a) Read dest JSON (or {} if absent).
  const capturedPremerge = { ...captureConfigPremerge(configPath), runtime };
  const carriedOrigin = priorOrigin(installRecordPath, runtime, configPath);
  let existing = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      process.stderr.write(
        `install-merge: warning: could not parse existing ${configPath} (${err.message}); treating as empty\n`
      );
      existing = {};
    }
  }

  // Read the managed (bundle-generated) config.
  let managed = {};
  try {
    managed = JSON.parse(fs.readFileSync(managedHooksPath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `install-merge: error: could not read managed config ${managedHooksPath}: ${err.message}\n`
    );
    process.exitCode = 1;
    return;
  }

  // (a2) Subtract caller-omitted managed keys. Only whole top-level keys are supported: the
  // one caller today mirrors the dogfood/--global strip exactly (`delete managed[key]`), and a
  // dotted-path variant would need its own conflict semantics inside mergePermissions().
  for (const key of omitManagedKeys) {
    if (key.includes(".")) throw new Error(`install-merge: --omit-managed-key expects a top-level key, got '${key}'`);
    delete managed[key];
  }

  // (b) + (c) + (d) Merge.
  const conflicts = [];
  const merged = mergeSettings(existing, managed, { onConflict: (item) => conflicts.push(item) });
  for (const item of conflicts) {
    process.stderr.write(
      `install-merge: conflict: preserving existing setting '${item.path}' and not applying Flow Agents managed value\n`
    );
  }

  // (e) Atomic write.
  atomicWriteJson(configPath, merged);

  // (f) Write version stamp.
  const previous = stampConfigPremergePostInstallHash(capturedPremerge, configPath);
  // `origin` answers ownership provenance (before Flow Agents first touched this
  // path); `previous` answers byte-fidelity restore (before this install). They
  // must not be conflated: a reinstall otherwise either loses user edits or
  // mistakes our first install's values for user-owned values forever.
  const origin = carriedOrigin.state === "valid" ? carriedOrigin.origin
    : carriedOrigin.state === "invalid" ? { schema_version: "unknown" }
      : previous;
  writeInstallRecord(installRecordPath, version, runtime, { schema_version: "2.0", origin, previous }, installedValues(configPath, merged, managed));
}

// ─── CLI wrapper ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const flags = {};
  // Repeatable: the naive `flags[key] = value` loop below would keep only the last
  // occurrence, and the caller passes one per key to omit.
  const omitManagedKeys = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--stamp-only") {
      flags["stamp-only"] = "1";
    } else if (args[i] === "--omit-managed-key" && i + 1 < args.length) {
      omitManagedKeys.push(args[i + 1]);
      i++;
    } else if (args[i].startsWith("--") && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }

  const stampOnly = flags["stamp-only"] === "1";
  const configPath = flags["config"];
  const managedHooksPath = flags["managed-hooks"];
  const version = flags["version"] || "unknown";
  const installRecordPath = flags["install-record"];
  const runtime = flags["runtime"] || "claude-code";

  if (stampOnly) {
    // Stamp-only mode: write install.json without merging any config file.
    // Used by runtimes (pi, kiro, base) that do not have a shared config to merge.
    if (!installRecordPath) {
      process.stderr.write(
        "usage: node install-merge.js --stamp-only --version <ver> --install-record <path> --runtime <runtime>\n"
      );
      process.exitCode = 2;
    } else {
      try {
        writeInstallRecord(installRecordPath, version, runtime);
      } catch (err) {
        process.stderr.write(`install-merge: error: ${err.message}\n`);
        process.exitCode = 1;
      }
    }
  } else if (!configPath || !managedHooksPath || !installRecordPath) {
    process.stderr.write(
      "usage: node install-merge.js --config <path> --managed-hooks <path> --version <ver> --install-record <path> --runtime <runtime>\n"
    );
    process.exitCode = 2;
  } else {
    try {
      runMerge({ configPath, managedHooksPath, version, installRecordPath, runtime, omitManagedKeys });
    } catch (err) {
      process.stderr.write(`install-merge: error: ${err.message}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = { mergeSettings, isManagedHookGroup, isManagedInnerHook, FA_MARKERS, captureConfigPremerge, installedValues, restoreConfigPremergeBytes };
