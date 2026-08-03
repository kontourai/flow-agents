'use strict';
/**
 * install-freshness.js — shared pure-CJS library for the SessionStart install-freshness advisory
 * (kontourai/flow-agents#1180, PR 2).
 *
 * Zero external dependencies (only Node core: fs, path, child_process). Consumed by:
 *   - scripts/hooks/workflow-steering.js (CJS, lazy `require()` — the SessionStart advisory)
 *
 * WHY THIS EXISTS: the incident #1180 records is an agent session running OLD installed hooks,
 * skills, and agents while reading and editing NEW source. Nothing said so. The whole session's
 * conclusions about "does the hook do X" were then about code that was not running. PR 1 shipped
 * the identity stamp that makes the installed artifact self-describing
 * (`build/generated/install-identity.json`, src/tools/generate-install-identity.ts); this library
 * is the read side that turns that stamp into ONE actionable line at the session boundary.
 *
 * DESIGN PRIORITY — FALSE STALENESS IS WORSE THAN SILENCE. An advisory that cries stale at a
 * developer who just installed a tarball packed from `main` trains every future reader to ignore
 * it, and the one session where the install really is old is then also ignored. Every branch in
 * this file therefore fails toward SILENCE: unresolvable identity, unavailable git, an absent or
 * expired registry cache, an unparseable version, any thrown error — all return ''. The only two
 * ways to emit are a POSITIVE ancestry proof (signal 1) or a POSITIVE strictly-greater released
 * version in a cache this process is allowed to trust (signal 2).
 *
 * TWO SIGNALS, FIRST DETERMINABLE WINS:
 *
 *   1. Checkout signal (no network, authoritative when available). When the session's repo is
 *      itself a Flow Agents checkout and the installed stamp carries a git sha: the install is
 *      stale iff that sha is a STRICT ANCESTOR of the checkout's `origin/main`.
 *      ANCESTRY, NOT VERSION COMPARISON, IS THE POINT. A tarball packed from post-release `main`
 *      installs as "5.7.0" while containing 5.8.0's code — a version compare would call that
 *      install stale forever, which is exactly the live false-staleness shape #1180 warns about.
 *      An installed sha that is not behind `origin/main` is, by definition, not behind it:
 *      determinable-FRESH, silent, no registry fallback. (Accepted edge: a commit that was
 *      rebased away is not an ancestor and so reports fresh. It fails silent, which is this
 *      file's stated failure direction.)
 *
 *   2. Registry TTL cache (network-free at advisory time). The advisory READS ONLY a cache file
 *      (`<claude-global-dest>/.flow-agents/registry-latest.json`, a sibling of the `install.json`
 *      that `src/cli/init.ts`'s `writeInstallRecord` already writes). It NEVER runs `npm view`
 *      itself. When the cache is absent or older than the TTL, a DETACHED best-effort refresh
 *      child is spawned and the advisory stays silent for this session — so the first session on
 *      a machine seeds the cache and says nothing, and no SessionStart ever waits on a network
 *      round trip. Staleness requires the cached latest to be a strictly greater RELEASED version
 *      (`x.y.z` on both sides; a prerelease or any unparseable string is silence, never a claim).
 *
 * NOT HASH-GUARDED (unlike #1172's STATE block): this line is composed on SessionStart only —
 * a session boundary, at most a handful of times per session — and it is self-silencing the
 * moment the install is refreshed. There is no repeat to suppress.
 *
 * BOUNDARY ONLY: `workflow-steering.js` calls this from its SessionStart-unconditional block and
 * nowhere else. It must never ride along on UserPromptSubmit — an install cannot go stale
 * mid-session, so a per-turn copy would be pure context tax.
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { resolveClaudeGlobalSkillsDir } = require('./skill-drift');

/** The one package this advisory speaks about. Anything else is not ours to comment on. */
const FLOW_AGENTS_PACKAGE_NAME = '@kontourai/flow-agents';
/** Repo-relative path of PR 1's stamp — must stay identical to INSTALL_IDENTITY_STAMP_REL in src/tools/generate-install-identity.ts. */
const INSTALL_IDENTITY_STAMP_REL = ['build', 'generated', 'install-identity.json'];
/** Cache file, a sibling of `install.json` under the same durable `.flow-agents` root. */
const REGISTRY_CACHE_REL = ['.flow-agents', 'registry-latest.json'];
/** How long a cached `npm view` answer is allowed to drive advice. */
const REGISTRY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bound on every git call so a slow or locked repo can never hang a SessionStart. */
const GIT_TIMEOUT_MS = 5000;
/** Bound on the DETACHED refresh child's registry call. Never awaited by the hook. */
const NPM_VIEW_TIMEOUT_MS = 20000;
/** argv marker that puts this file in refresh-child mode (see the `require.main` block below). */
const REFRESH_ARGV_FLAG = '--refresh-registry-cache';
/** A full commit sha, as `generate-install-identity.ts` records it. */
const SHA_RE = /^[0-9a-f]{40,64}$/;
/**
 * A RELEASED version, and deliberately nothing else. `5.9.0-rc.1` is not "greater than 5.8.0"
 * for advice purposes — telling a user to install a prerelease they did not opt into is a wrong
 * instruction, not a conservative one. Unparseable on either side ⇒ silence.
 */
const RELEASE_VERSION_RE = /^\d+\.\d+\.\d+$/;
/**
 * A version safe to interpolate into the literal `npm pack` tarball name the checkout advisory
 * prints. Broader than RELEASE_VERSION_RE on purpose — a prerelease checkout still packs a real
 * tarball, and this signal's verdict comes from git ancestry, not from the version — but narrow
 * enough that nothing outside npm's own version alphabet reaches the command text.
 */
const PACKABLE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]*$/;
/** The distinguishing marker of this advisory, matched by evals. */
const ADVISORY_MARKER = '[INSTALL STALE]';

/**
 * The package root of the Flow Agents install whose hook copy is CURRENTLY EXECUTING, or null.
 *
 * ONE FIXED OFFSET, NO SEARCH — the same closed-enumeration philosophy as telemetry.sh's
 * `install_identity_package_root` (#1180 PR 1), with a set of exactly one member here. This file
 * ships at `scripts/hooks/lib/` and nowhere else: unlike `workflow-steering.js` and the hook libs
 * listed in `src/tools/validate-source-tree.ts`'s `mirroredFiles` map, it has NO
 * `context/scripts/hooks/lib/` mirror (`skill-drift.js`, its sibling advisory library, is
 * un-mirrored for the same reason — the mirrored `workflow-steering.js` copy `require()`s this
 * path, fails, and stays inert). So the package root is `../../..` from this directory, always.
 *
 * WHY NOT A WALK UP THE TREE — this is the load-bearing part, and PR 1's review is why it is
 * written down twice. A bounded climb makes ANCESTOR ADOPTION reachable: install a bundle into a
 * scratch directory nested somewhere under a Flow Agents checkout — an entirely ordinary thing to
 * do — and the climb walks past the bundle's own stampless root, past the scratch directory,
 * reaches the surrounding checkout, and reports THAT checkout's identity as the running install's.
 * The advisory would then compare a checkout against itself and confidently report "fresh" for an
 * install it never actually looked at. A confidently wrong identity is strictly worse than none:
 * with a fixed offset, a copy at an unexpected depth resolves to a directory whose package.json
 * does not declare this package, and the advisory goes silent — which is honest.
 *
 * Consequence, deliberate: hook copies that live outside a real package root — the universal
 * bundles under `dist/<runtime>/scripts/`, whose bundle root carries no top-level `package.json`
 * (see `copySharedContent` in src/tools/build-universal-bundles.ts) — resolve to null and this
 * advisory is silent for them. The `--global` claude-code install, which pins every hook command
 * to an absolute path inside the installed npm package (`rewriteCommandsForGlobalInstall` in
 * src/cli/init.ts), is the case the #1180 incident actually happened in, and it resolves.
 *
 * @param {string} dir  Directory of this file (overridable for tests only)
 * @returns {string|null}
 */
function hookPackageRoot(dir = __dirname) {
  try {
    const candidate = path.resolve(dir, '..', '..', '..');
    return isFlowAgentsPackageRoot(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Tolerant JSON read: missing, unreadable, or unparseable are all "absent" (null), never thrown —
 * the same advisory-read tolerance `skill-drift.js`'s `loadManifest` establishes.
 *
 * @param {string} file
 * @returns {object|null}
 */
function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Does `root` hold a package.json declaring THIS package? Same test telemetry.sh's
 * `install_identity_is_flow_agents_package` applies, in CJS.
 *
 * @param {string} root
 * @returns {boolean}
 */
function isFlowAgentsPackageRoot(root) {
  const manifest = readJsonFile(path.join(root, 'package.json'));
  return Boolean(manifest && manifest.name === FLOW_AGENTS_PACKAGE_NAME);
}

/**
 * Identity of the install running this hook: `{ packageRoot, packageName, version, gitSha }`,
 * or null when it cannot be established (⇒ the advisory is silent).
 *
 * `FLOW_AGENTS_INSTALL_IDENTITY_ROOT` overrides the package root for fixture isolation — the
 * SAME override name and purpose telemetry.sh's `install_identity()` already exposes (#1180
 * PR 1). It is validated exactly like a resolved root: an override pointing at something that is
 * not a Flow Agents package yields null, never a fabricated identity.
 *
 * `version` prefers the stamp's `package_version` (the identity of record, asserted equal to
 * package.json at pack time by validate:source) and falls back to package.json for installs
 * predating the stamp. `gitSha` is null unless the stamp carries a well-formed sha.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ packageRoot: string, packageName: string, version: string, gitSha: string|null }|null}
 */
function installedIdentity(env = process.env) {
  try {
    const rawOverride = env && typeof env.FLOW_AGENTS_INSTALL_IDENTITY_ROOT === 'string' ? env.FLOW_AGENTS_INSTALL_IDENTITY_ROOT.trim() : '';
    // An override REPLACES the resolution — it never falls back to the real hook root, or a
    // fixture pointing somewhere unexpected would silently report the developer's own install.
    const packageRoot = rawOverride ? path.resolve(rawOverride) : hookPackageRoot();
    if (!packageRoot || !isFlowAgentsPackageRoot(packageRoot)) return null;
    const manifest = readJsonFile(path.join(packageRoot, 'package.json'));
    if (!manifest || manifest.name !== FLOW_AGENTS_PACKAGE_NAME) return null;
    const stamp = readJsonFile(path.join(packageRoot, ...INSTALL_IDENTITY_STAMP_REL));
    const stampVersion = stamp && typeof stamp.package_version === 'string' ? stamp.package_version.trim() : '';
    const manifestVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
    const version = stampVersion || manifestVersion;
    if (!version) return null;
    const rawSha = stamp && typeof stamp.git_sha === 'string' ? stamp.git_sha.trim().toLowerCase() : '';
    return {
      packageRoot,
      packageName: FLOW_AGENTS_PACKAGE_NAME,
      version,
      gitSha: SHA_RE.test(rawSha) ? rawSha : null,
    };
  } catch {
    return null;
  }
}

/**
 * Environment for every git call — the trusted-environment idiom
 * `scripts/hooks/lib/effective-flow-agents-config.js` already establishes for hook-side git.
 * Ambient system/global git config is precisely what an advisory must not be steerable by, and
 * the fixed PATH is why this advisory keeps working in a session whose PATH is unusual.
 */
function trustedGitEnvironment() {
  return {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32' : '/usr/bin:/bin',
  };
}

/**
 * Bounded, never-throwing git call that PRESERVES THE EXIT STATUS — `merge-base --is-ancestor`
 * answers with its status (0 ancestor, 1 not an ancestor, 128 error/unknown commit), and
 * collapsing "not an ancestor" into "failed" would silently turn a determinable-fresh answer
 * into a registry fallback.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {{ status: number, stdout: string }|null}
 */
function git(cwd, args) {
  try {
    const executable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
    const res = spawnSync(executable, ['--no-replace-objects', '-C', cwd, ...args], {
      encoding: 'utf8',
      env: trustedGitEnvironment(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
    });
    if (!res || res.error || typeof res.status !== 'number') return null;
    return { status: res.status, stdout: typeof res.stdout === 'string' ? res.stdout : '' };
  } catch {
    return null;
  }
}

/**
 * Signal 1 — is the installed commit behind the session checkout's `origin/main`?
 *
 * Returns `{ determinable: false }` unless every input is positively established: the session
 * repo declares THIS package, it has a version (needed for the literal reinstall command), the
 * stamp carries a sha, `origin/main` resolves, and the ancestry question is answered without
 * error. Every git failure — no git, no repo, no `origin/main`, an installed sha that is not even
 * in this repo's object database (a tarball built elsewhere) — is undeterminable, not stale.
 *
 * @param {string} root       Session repository root
 * @param {ReturnType<typeof installedIdentity>} identity
 * @returns {{ determinable: boolean, stale?: boolean, installedSha?: string, headSha?: string, checkoutVersion?: string }}
 */
function checkoutStaleness(root, identity) {
  const undeterminable = { determinable: false };
  if (!identity || !identity.gitSha) return undeterminable;
  const manifest = readJsonFile(path.join(root, 'package.json'));
  if (!manifest || manifest.name !== FLOW_AGENTS_PACKAGE_NAME) return undeterminable;
  const checkoutVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  if (!PACKABLE_VERSION_RE.test(checkoutVersion)) return undeterminable;

  const head = git(root, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
  if (!head || head.status !== 0) return undeterminable;
  const headSha = head.stdout.trim().toLowerCase();
  if (!SHA_RE.test(headSha)) return undeterminable;
  if (headSha === identity.gitSha) return { determinable: true, stale: false };

  const ancestor = git(root, ['merge-base', '--is-ancestor', identity.gitSha, headSha]);
  if (!ancestor) return undeterminable;
  // 1 = a definite "no": the installed commit is not behind origin/main (a tarball packed from a
  // branch, or from main AFTER the current origin/main was fetched). Fresh, silent, final.
  if (ancestor.status === 1) return { determinable: true, stale: false };
  // Anything other than 0 or 1 is git declining to answer (e.g. 128 for a commit this repo has
  // never seen) — not evidence of staleness.
  if (ancestor.status !== 0) return undeterminable;
  return { determinable: true, stale: true, installedSha: identity.gitSha, headSha, checkoutVersion };
}

/**
 * Absolute path of the registry TTL cache, honoring `FLOW_AGENTS_USER_CLAUDE_SETTINGS` through
 * `skill-drift.js`'s `resolveClaudeGlobalSkillsDir` — consumed, not re-derived, so this file and
 * the skills manifest can never disagree about where the durable install-scoped sidecars live.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function registryCachePath(env = process.env) {
  return path.join(resolveClaudeGlobalSkillsDir(env), ...REGISTRY_CACHE_REL);
}

/**
 * Numeric triple comparison of two RELEASED versions. Returns -1 / 0 / 1, or null when either
 * side is not exactly `x.y.z`. Hand-rolled on purpose: this library takes no dependencies, and
 * the only question it has to answer is "is the registry's latest release strictly newer".
 *
 * @param {string} left
 * @param {string} right
 * @returns {number|null}
 */
function compareReleaseVersions(left, right) {
  if (!RELEASE_VERSION_RE.test(String(left)) || !RELEASE_VERSION_RE.test(String(right))) return null;
  const a = String(left).split('.').map(Number);
  const b = String(right).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

/**
 * Signal 2 — does a cache entry this process may trust report a strictly newer released version?
 *
 * READ ONLY. This never contacts the registry; `refresh: true` merely tells the caller that a
 * detached best-effort refresh is warranted (cache absent, expired, clock-skewed into the future,
 * or recorded for a different package).
 *
 * @param {ReturnType<typeof installedIdentity>} identity
 * @param {NodeJS.ProcessEnv} env
 * @param {number} now
 * @returns {{ determinable: boolean, stale?: boolean, latest?: string, refresh: boolean }}
 */
function registryStaleness(identity, env = process.env, now = Date.now()) {
  if (!identity) return { determinable: false, refresh: false };
  const cache = readJsonFile(registryCachePath(env));
  if (!cache) return { determinable: false, refresh: true };
  const fetchedAt = typeof cache.fetched_at === 'string' ? Date.parse(cache.fetched_at) : NaN;
  const age = now - fetchedAt;
  if (!Number.isFinite(age) || age < 0 || age > REGISTRY_CACHE_TTL_MS) return { determinable: false, refresh: true };
  if (cache.package !== identity.packageName) return { determinable: false, refresh: true };
  const latest = typeof cache.latest_version === 'string' ? cache.latest_version.trim() : '';
  // `latest_version: null` is the refresh child's honest record of "we asked and got no usable
  // answer" — it keeps the TTL from re-spawning a doomed child every single SessionStart.
  const comparison = compareReleaseVersions(latest, identity.version);
  if (comparison === null) return { determinable: false, refresh: false };
  return comparison > 0
    ? { determinable: true, stale: true, latest, refresh: false }
    : { determinable: true, stale: false, refresh: false };
}

/**
 * Atomically write the registry cache (tmp-write-then-rename, the same idiom `src/cli/init.ts`
 * uses for `install.json` and `skill-drift.js` for the skills manifest).
 *
 * @param {string} file
 * @param {{ package: string, latest_version: string|null, fetched_at: string }} record
 * @returns {void}
 */
function writeRegistryCacheAtomic(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Spawn the DETACHED best-effort refresh child and return immediately. The child is this very
 * file re-entered with `REFRESH_ARGV_FLAG` (one file, no second script to keep in sync, and the
 * child path is `__filename` — absolute, with no resolution ambiguity). `detached` + `unref` +
 * ignored stdio means SessionStart never waits on and never reads a network round trip.
 *
 * Skipped entirely when the durable install directory does not exist: an advisory has no business
 * creating a runtime's config directory on a machine where the install never wrote one.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean} whether a child was spawned (for tests/callers; never affects the advisory)
 */
function spawnRegistryRefresh(env = process.env) {
  try {
    if (!fs.existsSync(resolveClaudeGlobalSkillsDir(env))) return false;
    const child = spawn(process.execPath, [__filename, REFRESH_ARGV_FLAG], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.on('error', () => {}); // never surface a spawn failure
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The refresh child's whole job: ask the registry once, record the answer (or the lack of one),
 * exit. Runs ONLY in the detached child — never on the SessionStart path.
 *
 * A failed lookup still writes `latest_version: null` with a current `fetched_at`. That is not a
 * fabricated answer, it is an honest "asked at T, got nothing", and it is what keeps a machine
 * with no registry access from spawning a doomed child on every single SessionStart.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {void}
 */
function refreshRegistryCacheNow(env = process.env) {
  const identity = installedIdentity(env);
  if (!identity) return;
  if (!fs.existsSync(resolveClaudeGlobalSkillsDir(env))) return;
  let latest = null;
  try {
    // npm is spawned by NAME here, on the ambient PATH, because a registry lookup needs the
    // caller's real npm configuration (registry, auth, proxy) — the hardened fixed PATH used for
    // git would be wrong. On Windows the executable is `npm.cmd`, which this call does not handle;
    // that is the shared runtime-executable-resolution gap tracked by #1183, deliberately not
    // solved here (a Windows miss writes `latest_version: null` and stays silent).
    const out = spawnSync('npm', ['view', identity.packageName, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: NPM_VIEW_TIMEOUT_MS,
      env,
    });
    if (out && !out.error && out.status === 0 && typeof out.stdout === 'string') {
      const parsed = JSON.parse(out.stdout);
      if (typeof parsed === 'string' && RELEASE_VERSION_RE.test(parsed.trim())) latest = parsed.trim();
    }
  } catch { /* best effort: recorded below as "asked, got nothing" */ }
  try {
    writeRegistryCacheAtomic(registryCachePath(env), {
      package: identity.packageName,
      latest_version: latest,
      fetched_at: new Date().toISOString(),
    });
  } catch { /* unwritable cache: next SessionStart simply tries again */ }
}

/** Collapse any whitespace so the advisory is unconditionally ONE line. */
function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * The ONE line, in each signal's own vocabulary, each naming the exact command that fixes it.
 * Refreshing the npm package alone is not enough — the global runtime assets (skills, agents,
 * settings) are written by `flow-agents init`, so every variant carries it.
 */
function checkoutAdvisoryLine(signal) {
  return oneLine(`${ADVISORY_MARKER} The Flow Agents install running this session's hooks is commit ${signal.installedSha.slice(0, 8)},
    which is BEHIND this checkout's origin/main (${signal.headSha.slice(0, 8)}) — the hooks, skills, and agents acting on this
    session are older than the source you are reading, so behavior you observe may not be the behavior in this tree.
    Reinstall from this checkout: \`npm pack && npm install -g ./kontourai-flow-agents-${signal.checkoutVersion}.tgz &&
    flow-agents init --runtime claude-code --global\`.`);
}

function registryAdvisoryLine(identity, signal) {
  return oneLine(`${ADVISORY_MARKER} Flow Agents ${identity.version} is installed; the npm registry's latest release is
    ${signal.latest}, so the hooks, skills, and agents acting on this session are older than the published package.
    Reinstall: \`npm install -g ${identity.packageName}@${signal.latest} && flow-agents init --runtime claude-code --global\`.`);
}

/**
 * The advisory. Returns '' — silently, always — when the install is fresh, when freshness cannot
 * be determined, or on any error whatsoever.
 *
 * @param {{ root: string, env?: NodeJS.ProcessEnv }} options
 * @returns {string}
 */
function installFreshnessAdvisory(options = {}) {
  try {
    const root = options.root;
    const env = options.env || process.env;
    if (typeof root !== 'string' || !root) return '';
    const identity = installedIdentity(env);
    if (!identity) return '';

    const checkout = checkoutStaleness(root, identity);
    if (checkout.determinable) return checkout.stale ? checkoutAdvisoryLine(checkout) : '';

    const registry = registryStaleness(identity, env);
    if (registry.refresh) spawnRegistryRefresh(env);
    if (registry.determinable && registry.stale) return registryAdvisoryLine(identity, registry);
    return '';
  } catch {
    return '';
  }
}

// Refresh-child mode. Nothing else may run this file as a program.
if (require.main === module && process.argv[2] === REFRESH_ARGV_FLAG) {
  try {
    refreshRegistryCacheNow(process.env);
  } catch { /* never surface */ }
}

module.exports = {
  ADVISORY_MARKER,
  FLOW_AGENTS_PACKAGE_NAME,
  REGISTRY_CACHE_TTL_MS,
  REFRESH_ARGV_FLAG,
  hookPackageRoot,
  installedIdentity,
  checkoutStaleness,
  registryCachePath,
  compareReleaseVersions,
  registryStaleness,
  spawnRegistryRefresh,
  refreshRegistryCacheNow,
  installFreshnessAdvisory,
};
