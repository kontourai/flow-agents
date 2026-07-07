'use strict';
/**
 * skill-drift.js — shared pure-CJS manifest/drift-comparison library for installed Claude Code
 * skill files (kontourai/flow-agents#439, slice 1).
 *
 * Zero external dependencies (only Node core: fs, path, crypto, os). Consumed by:
 *   - src/cli/init.ts               (compiled ESM, via createRequire — writes the manifest at
 *                                     `init --global` sync time, Wave 2)
 *   - src/cli/skill-drift-check.ts  (compiled ESM, via createRequire — standalone read-only
 *                                     CLI check, Wave 2)
 *   - scripts/hooks/workflow-steering.js (CJS, direct require — SessionStart advisory, Wave 2)
 *
 * Purpose (issue #439): this is the SINGLE choke point for classifying installed-skill drift so
 * the manifest writer, the CLI check, and the SessionStart advisory can never disagree with one
 * another about what "in sync" / "stale" / "user-modified" means for a given file. Every consumer
 * calls `compareSkillDrift()` instead of hand-rolling its own comparison, mirroring the same
 * "one shared CJS module, multiple TS/hook consumers" convention already established by
 * `current-pointer.js` (#291) and `actor-identity.js` for this repo's TS/CJS boundary.
 *
 * Hashing convention: `hashFile()` returns `"sha256:<hex>"` — the SAME string prefix convention
 * `src/cli/kit.ts`'s `contentHash`/`kitContentHash` already established for Flow Kit installs.
 * This module does not invent a second hash format (ADR 0008/0010 consume-never-fork).
 *
 * File-walk convention: `walkFilesSorted()`/`relPathPosix()` re-implement the SAME
 * sorted-recursive-`readdirSync` traversal and POSIX-joined relative-path normalization as
 * `src/lib/fs.ts`'s `walkFiles`/`relPath` — byte-identical relative-path strings for the same
 * directory tree. This file cannot `import` that TS module directly (it must stay pure CJS so
 * `workflow-steering.js` can `require()` it directly without a compiled-ESM detour), so it is an
 * intentional, minimal, SAME-SHAPE re-implementation across the CJS boundary, not a fork of
 * behavior — this must not diverge from `walkFiles`/`relPath` at review time.
 *
 * Exports:
 *   hashFile(absPath)                                  → "sha256:<hex>" string
 *   buildManifest({ skillsSourceDir, runtime })         → manifest object (see below)
 *   loadManifest(manifestPath)                          → parsed manifest object, or null if
 *                                                          absent/unreadable (never throws)
 *   writeManifestAtomic(manifestPath, manifest)          → void (tmp-write-then-rename, same
 *                                                          idiom `src/cli/init.ts` uses for
 *                                                          `install.json`)
 *   compareSkillDrift({ installedDir, kitSourceDir, manifest }) → drift report (see below)
 *   resolveClaudeGlobalSkillsDir(env = process.env)      → string (the global claude-code dest
 *                                                          dir, e.g. `~/.claude`, honoring
 *                                                          FLOW_AGENTS_USER_CLAUDE_SETTINGS for
 *                                                          test isolation — same resolution
 *                                                          `src/cli/init.ts`'s `globalDest`
 *                                                          already implements for "claude-code")
 *
 * Manifest shape:
 *   {
 *     schema_version: "1.0",
 *     runtime: string,
 *     generatedAt: string (ISO 8601),
 *     sourceDir: string,
 *     files: { "<skill>/<relpath>": "sha256:<hex>", ... }
 *   }
 *
 * Drift report shape (from compareSkillDrift):
 *   {
 *     checkedAt: string (ISO 8601),
 *     installedDir: string,
 *     kitSourceDir: string,
 *     manifestFound: boolean,
 *     files: [{ path, state, installedHash, kitHash, manifestHash }],
 *     summary: { total, inSync, kitUpdated, userModified, unbaselined, missingInstall, kitRemoved },
 *     hasDrift: boolean
 *   }
 *
 * Classification states (one of exactly six per file; names must stay identical across every
 * consumer — the manifest writer, the CLI check, and the hook advisory never hand-roll their own
 * classification strings):
 *   - "in_sync"        installedHash === kitHash (installed bytes already match current kit
 *                       source, regardless of manifest).
 *   - "kit_updated"     installedHash !== kitHash but installedHash === manifestHash (installed
 *                       copy matches the last recorded baseline; kit source has since changed).
 *   - "user_modified"   installedHash !== manifestHash (and not in_sync) — installed bytes were
 *                       changed locally since the last recorded install. This ALWAYS wins over
 *                       "kit_updated" when both installedHash !== kitHash and
 *                       installedHash !== manifestHash are true (never silently reclassified as
 *                       a kit update).
 *   - "unbaselined"     no manifest entry exists for this path (manifest missing entirely, or
 *                       present but lacking this path's key) and installedHash !== kitHash —
 *                       reported distinctly, never conflated with user_modified/kit_updated.
 *   - "missing_install" a kit-source file has no installed counterpart at all (skill never
 *                       synced locally yet) — reported distinctly, though also resolved by the
 *                       same refresh command as the other non-in_sync states.
 *   - "kit_removed"     kitHash === null (the path no longer exists anywhere in the current kit
 *                       source) but the installed file still matches the last recorded baseline
 *                       exactly (installedHash === manifestHash). Distinct from "kit_updated":
 *                       the additive `copyDirMerge`-based refresh can only add/update files, it
 *                       can never delete, so it cannot "fix" this state — reported with guidance
 *                       to review/remove the installed file manually. Sub-case precedence:
 *                       kitHash === null AND installedHash !== manifestHash still classifies as
 *                       "user_modified" (installed bytes differ from the recorded baseline wins
 *                       over "kit_removed", same precedence rule as the kit_updated case above).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/**
 * Sorted recursive file walk — mirrors `src/lib/fs.ts`'s `walkFiles` exactly (sorted
 * `fs.readdirSync`, depth-first, files only). Returns absolute paths.
 *
 * Uses `readdirSync(dir, { withFileTypes: true })` Dirent type checks — NOT `fs.statSync`, which
 * follows symlinks — so a symlink under the tree (e.g. pointing outside it, or dangling/looped)
 * is neither followed nor hashed, and never throws (ELOOP / ENOENT on a dangling symlink). This
 * is the exact same semantics `copyDirMerge` already uses for install copying
 * (`src/cli/init.ts`): recurse into `entry.isDirectory()`, include `entry.isFile()`, silently
 * skip everything else (symlinks, sockets, etc). Manifest/drift walking and install copying must
 * never disagree about which files exist.
 *
 * @param {string} root
 * @returns {string[]}
 */
function walkFilesSorted(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFilesSorted(file));
    else if (entry.isFile()) out.push(file);
    // else: symlink, socket, fifo, etc — skip (see doc comment above).
  }
  return out;
}

/**
 * POSIX-joined relative path — mirrors `src/lib/fs.ts`'s `relPath` exactly.
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function relPathPosix(root, file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel)
    ? rel.split(path.sep).join('/')
    : file.split(path.sep).join('/');
}

/**
 * `sha256:<hex>` content hash of a single file — same prefix convention as
 * `src/cli/kit.ts`'s `contentHash`/`kitContentHash`.
 *
 * @param {string} absPath
 * @returns {string}
 */
function hashFile(absPath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(absPath));
  return `sha256:${hash.digest('hex')}`;
}

/**
 * Builds a per-skill-file content-hash manifest by walking `skillsSourceDir` (e.g. a built
 * `dist/claude-code/.claude/skills` bundle directory). Keys are POSIX relative paths under
 * `skillsSourceDir` (e.g. `pull-work/SKILL.md`).
 *
 * @param {{ skillsSourceDir: string, runtime: string }} params
 * @returns {object} manifest (see module doc comment for shape)
 */
function buildManifest({ skillsSourceDir, runtime }) {
  const files = {};
  for (const file of walkFilesSorted(skillsSourceDir)) {
    const rel = relPathPosix(skillsSourceDir, file);
    files[rel] = hashFile(file);
  }
  return {
    schema_version: '1.0',
    runtime,
    generatedAt: new Date().toISOString(),
    sourceDir: skillsSourceDir,
    files,
  };
}

/**
 * Best-effort tolerant manifest read: missing file or corrupt/unparseable content are BOTH
 * treated as "absent" (returns null), never thrown — mirrors the `readCurrentPointer`-style
 * tolerance already established for advisory reads in this repo.
 *
 * @param {string} manifestPath
 * @returns {object|null}
 */
function loadManifest(manifestPath) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomic write: tmp-write-then-rename, the SAME idiom `src/cli/init.ts` already uses for
 * `install.json` (`${path}.tmp.${pid}` then `fs.renameSync`).
 *
 * @param {string} manifestPath
 * @param {object} manifest
 * @returns {void}
 */
function writeManifestAtomic(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, manifestPath);
}

/**
 * Hashes a single relative path under `dir`, if it exists there as a file. Returns null if
 * absent (covers both "not installed yet" and "not present in this kit source snapshot").
 *
 * @param {string} dir
 * @param {string} rel
 * @returns {string|null}
 */
function hashRelIfPresent(dir, rel) {
  const abs = path.join(dir, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  try {
    return hashFile(abs);
  } catch {
    // Race between the existsSync/statSync check above and this read (file deleted or made
    // unreadable in between — ENOENT/EACCES) — treat as "hash unavailable" (null), same as "not
    // present", rather than throwing and crashing the whole drift check over one flaky file.
    return null;
  }
}

/**
 * Compares installed skill files, the current kit/bundle source, and the last-recorded manifest
 * baseline, classifying every relative path into exactly one of six states. See the module doc
 * comment for the full state semantics and precedence rules.
 *
 * @param {{ installedDir: string, kitSourceDir: string, manifest: object|null }} params
 * @returns {object} drift report (see module doc comment for shape)
 */
function compareSkillDrift({ installedDir, kitSourceDir, manifest }) {
  const manifestFiles = manifest && manifest.files && typeof manifest.files === 'object' ? manifest.files : null;

  const relPaths = new Set();
  for (const file of walkFilesSorted(kitSourceDir)) relPaths.add(relPathPosix(kitSourceDir, file));
  for (const file of walkFilesSorted(installedDir)) relPaths.add(relPathPosix(installedDir, file));
  if (manifestFiles) {
    for (const rel of Object.keys(manifestFiles)) {
      // Defense-in-depth: our own writer (`buildManifest`) only ever produces POSIX-relative
      // keys derived from `walkFilesSorted` + `relPathPosix`, so a key that is absolute, contains
      // a backslash, or has any '..' path segment can only come from a malformed or hostile
      // manifest — skip it entirely (never join it onto installedDir/kitSourceDir, never report
      // it) rather than trusting untrusted manifest content into a path.join.
      if (path.isAbsolute(rel) || rel.includes('\\') || rel.split('/').includes('..')) continue;
      relPaths.add(rel);
    }
  }

  const summary = { total: 0, inSync: 0, kitUpdated: 0, userModified: 0, unbaselined: 0, missingInstall: 0, kitRemoved: 0 };
  const files = [];

  for (const rel of Array.from(relPaths).sort()) {
    const installedHash = hashRelIfPresent(installedDir, rel);
    const kitHash = hashRelIfPresent(kitSourceDir, rel);
    const manifestHash = manifestFiles && Object.prototype.hasOwnProperty.call(manifestFiles, rel) ? manifestFiles[rel] : null;

    // A path recorded only in a stale manifest, with no counterpart in the kit source NOR the
    // installed dir any more, is nothing currently installable or driftable — skip it rather
    // than inventing a seventh state for it.
    if (installedHash === null && kitHash === null) continue;

    // An installed-only path with no kit-source counterpart AND no manifest entry is outside the
    // kit's jurisdiction entirely — e.g. another tool's skill directory living alongside
    // kit-installed skills under the same shared `~/.claude/skills` dest. `copyDirMerge`'s doc
    // contract (`src/cli/init.ts`) is explicit that the dest may hold unrelated content it must
    // never touch; the drift classifier honors the same boundary by staying silent about paths it
    // never owned, rather than reporting them "unbaselined". `unbaselined` stays reserved for
    // kit-owned paths (kitHash !== null) that simply predate the manifest baseline; `kit_removed`
    // is unaffected — a manifest entry there proves prior kit ownership, so it never reaches this
    // skip (manifestHash === null is required here).
    if (kitHash === null && manifestHash === null) continue;

    let state;
    if (kitHash !== null && installedHash === null) {
      state = 'missing_install';
    } else if (installedHash !== null && kitHash !== null && installedHash === kitHash) {
      state = 'in_sync';
    } else if (manifestHash === null) {
      state = 'unbaselined';
    } else if (installedHash !== manifestHash) {
      // user_modified always wins over kit_updated/kit_removed when installed bytes differ from
      // the recorded baseline — see module doc comment. This precedence also covers the
      // kitHash === null sub-case (file removed from kit source AND locally modified): still
      // reported as user_modified, never kit_removed.
      state = 'user_modified';
    } else if (kitHash === null) {
      // Installed file matches the last recorded baseline exactly, but no longer exists anywhere
      // in the current kit source (removed upstream). Distinct from kit_updated: the additive
      // copyDirMerge-based refresh cannot delete, so it cannot "fix" this state.
      state = 'kit_removed';
    } else {
      state = 'kit_updated';
    }

    files.push({ path: rel, state, installedHash, kitHash, manifestHash });
    summary.total += 1;
    if (state === 'in_sync') summary.inSync += 1;
    else if (state === 'kit_updated') summary.kitUpdated += 1;
    else if (state === 'user_modified') summary.userModified += 1;
    else if (state === 'unbaselined') summary.unbaselined += 1;
    else if (state === 'missing_install') summary.missingInstall += 1;
    else if (state === 'kit_removed') summary.kitRemoved += 1;
  }

  return {
    checkedAt: new Date().toISOString(),
    installedDir,
    kitSourceDir,
    manifestFound: manifest !== null,
    files,
    summary,
    hasDrift: files.some((entry) => entry.state !== 'in_sync'),
  };
}

/**
 * Resolves the global claude-code destination directory (e.g. `~/.claude`), honoring
 * `FLOW_AGENTS_USER_CLAUDE_SETTINGS` for test isolation — the SAME resolution
 * `src/cli/init.ts`'s `globalDest("claude-code")` already implements, re-implemented here in
 * pure CJS so `workflow-steering.js` can call it directly without a `createRequire`-of-a-
 * differently-shaped-compiled-path detour. `src/cli/skill-drift-check.ts` instead calls the
 * real exported `globalDest` from `init.ts` directly (already TS-to-TS, no duplication needed
 * there).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function resolveClaudeGlobalSkillsDir(env = process.env) {
  const override = env['FLOW_AGENTS_USER_CLAUDE_SETTINGS'];
  if (override) return path.dirname(override);
  return path.join(os.homedir(), '.claude');
}

module.exports = {
  hashFile,
  buildManifest,
  loadManifest,
  writeManifestAtomic,
  compareSkillDrift,
  resolveClaudeGlobalSkillsDir,
};
