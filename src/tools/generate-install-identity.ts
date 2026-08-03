#!/usr/bin/env node
/**
 * generate-install-identity.ts (#1180, PR 1) — the shipped producer-identity stamp.
 *
 * WHY A TUPLE AND NOT A VERSION: a semver string is a lying join key. A tarball packed from
 * post-release `main` installs as "5.7.0" while containing 5.8.0's code, so any per-release
 * effectiveness analysis keyed on version alone attributes the new behavior to the old release
 * (observed live during a dogfood reinstall — the incident issue #1180 records). The identity
 * this tool stamps is therefore `{package_version, content_fingerprint}`: the version says what
 * the artifact CLAIMS to be, the fingerprint says what it actually CONTAINS.
 *
 * Emits `build/generated/install-identity.json` (build/ is gitignored but SHIPS via package.json
 * `files`, exactly like `build/generated/capability-declarations.json` — the same build-only-JSON
 * precedent from generate-capability-matrix.ts). Wired as the LAST step of `npm run build`, so it
 * observes a complete `build/src` tree, and `prepack` (build:bundles + validate:source, both of
 * which run `build`) guarantees a fresh stamp in every pack.
 *
 * The fingerprint is computed ONCE at build time and read verbatim at event time — per-event
 * hashing of the package is unacceptable hook overhead.
 *
 * Hashing convention: `sha256:<hex>` per file, the SAME prefix convention
 * `scripts/hooks/lib/skill-drift.js`'s `hashFile()` and `src/cli/kit.ts`'s `contentHash` already
 * established (ADR 0008/0010 consume-never-fork — this does not invent a second hash format).
 *
 * Coverage (FINGERPRINT_ROOTS): the surfaces whose bytes change agent behavior — `scripts` (hooks,
 * telemetry), `build/src` (the compiled CLI/library that actually executes), `kits`, `skills`,
 * `agents`, `prompts`. Deliberately NOT covered: `dist/` (universal bundles are built by
 * `build:bundles` AFTER `build`, so hashing them here would hash a stale or absent tree), `docs/`
 * and `context/*.md` prose (documentation edits are not behavior changes and would churn the join
 * key), and `build/generated/` itself — which is where this stamp lives, so the stamp can never be
 * an input to its own digest.
 */
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadJson, rel, root, walkFiles, writeText } from "./common.js";

export const INSTALL_IDENTITY_SCHEMA_VERSION = "1.0";
/** Repo-relative path of the stamp — the single source both the writer and validate:source read. */
export const INSTALL_IDENTITY_STAMP_REL = "build/generated/install-identity.json";
/** Behavior-defining surfaces covered by the content fingerprint (see module doc comment). */
export const FINGERPRINT_ROOTS = ["agents", "build/src", "kits", "prompts", "scripts", "skills"];

const stampPath = path.join(root, INSTALL_IDENTITY_STAMP_REL);

export interface InstallIdentityStamp {
  schema_version: string;
  package_name: string;
  package_version: string;
  content_fingerprint: string;
  /** Full commit sha of the tree this artifact was built from, or null when git could not answer. */
  git_sha: string | null;
  /**
   * Whether that tree had uncommitted changes. `null` — NOT `false` — when `git_sha` is null: a
   * `false` there would assert "the tree was clean" about a tree that was never inspected, which
   * is the fabricated-signal failure this whole record exists to avoid.
   */
  git_dirty: boolean | null;
  built_at: string;
}

function packageManifest(): { name: string; version: string } {
  const pkg = loadJson<{ name?: unknown; version?: unknown }>(path.join(root, "package.json"));
  const name = typeof pkg.name === "string" ? pkg.name : "";
  const version = typeof pkg.version === "string" ? pkg.version : "";
  if (!name || !version) throw new Error("package.json is missing .name or .version");
  return { name, version };
}

/**
 * A `files` negation this generator understands. Exactly three narrow forms are supported — this
 * is deliberately NOT an implementation of npm's full `files` glob semantics.
 *
 *   path    "build/src/cli/workflow.test-support.js"  a single relative file
 *   segment "**\/.DS_Store" / "**\/node_modules/"     a name at any depth (file or directory)
 *   prefix  "evals/results/"                          a directory and everything under it
 */
type FilesNegation =
  | { kind: "path"; value: string }
  | { kind: "segment"; value: string }
  | { kind: "prefix"; value: string };

/**
 * Parses ONE `!`-prefixed package.json `files` entry, or THROWS.
 *
 * The throw is the point. This function used to silently `continue` past any entry containing a
 * glob or a trailing slash, which meant a future exclusion — `!kits/experimental/`, say — would
 * quietly leave the fingerprint covering content npm strips out of the tarball, so the shipped
 * artifact's identity would be a digest of files it does not contain. There is no safe default
 * for "an exclusion form I do not understand," so an unsupported form fails the build with the
 * offending entry named, forcing whoever edits `files` to extend this parser deliberately.
 */
export function parseFilesNegation(entry: string): FilesNegation {
  const candidate = entry.slice(1);
  const unsupported = (): never => {
    throw new Error(
      `package.json files entry '${entry}' uses an exclusion form generate-install-identity.ts does not support. ` +
        "Supported forms: a plain relative path, '**/<name>' or '**/<name>/' (a name at any depth), " +
        "and '<dir>/' (a directory prefix). Extend parseFilesNegation() rather than letting the content " +
        "fingerprint cover files the published tarball excludes.",
    );
  };
  if (candidate.startsWith("**/")) {
    const name = candidate.slice(3).replace(/\/$/, "");
    if (!name || name.includes("*") || name.includes("/")) unsupported();
    return { kind: "segment", value: name };
  }
  if (candidate.includes("*")) unsupported();
  if (candidate.endsWith("/")) return { kind: "prefix", value: candidate };
  if (!candidate) unsupported();
  return { kind: "path", value: candidate };
}

/**
 * Every negation in package.json's `files`, parsed. Reading the exclusions from the packaging
 * manifest instead of hardcoding them keeps "what the fingerprint covers" and "what ships" from
 * drifting apart — e.g. `build/src/cli/workflow.test-support.js`, which
 * `scripts/build-test-support.mjs` writes during `npm run test:unit`, is excluded from the tarball
 * and so must not perturb the digest of an otherwise identical build.
 */
function filesNegations(): FilesNegation[] {
  const pkg = loadJson<{ files?: unknown }>(path.join(root, "package.json"));
  const negations: FilesNegation[] = [];
  for (const entry of Array.isArray(pkg.files) ? pkg.files : []) {
    if (typeof entry !== "string" || !entry.startsWith("!")) continue;
    negations.push(parseFilesNegation(entry));
  }
  return negations;
}

function isExcluded(relative: string, negations: FilesNegation[]): boolean {
  const segments = relative.split("/");
  return negations.some((negation) => {
    switch (negation.kind) {
      case "path": return relative === negation.value;
      case "segment": return segments.includes(negation.value);
      case "prefix": return relative.startsWith(negation.value);
    }
  });
}

/** Sorted `<relpath>\0sha256:<hex>` lines over the covered surfaces (deterministic for a tree). */
export function fingerprintLines(): string[] {
  const negations = filesNegations();
  const lines: string[] = [];
  for (const dir of FINGERPRINT_ROOTS) {
    for (const file of walkFiles(path.join(root, dir))) {
      const relative = rel(file);
      if (isExcluded(relative, negations)) continue;
      lines.push(`${relative}\0sha256:${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`);
    }
  }
  // Default (UTF-16 code-unit) sort — locale-independent, so the same tree digests identically
  // on every machine that builds it.
  return lines.sort();
}

/** `sha256:<hex>` over the sorted per-file lines. */
export function contentFingerprint(): string {
  return `sha256:${crypto.createHash("sha256").update(fingerprintLines().join("\n")).digest("hex")}`;
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** HEAD sha and dirtiness of the tree this artifact was built from; both null when git cannot answer. */
export function gitState(): { git_sha: string | null; git_dirty: boolean | null } {
  const sha = gitOutput(["rev-parse", "HEAD"]);
  if (!sha || !/^[0-9a-f]{40,64}$/.test(sha)) return { git_sha: null, git_dirty: null };
  const status = gitOutput(["status", "--porcelain"]);
  return { git_sha: sha, git_dirty: status === null ? null : status.length > 0 };
}

export function buildStamp(now = new Date()): InstallIdentityStamp {
  const { name, version } = packageManifest();
  const { git_sha, git_dirty } = gitState();
  return {
    schema_version: INSTALL_IDENTITY_SCHEMA_VERSION,
    package_name: name,
    package_version: version,
    content_fingerprint: contentFingerprint(),
    git_sha,
    git_dirty,
    built_at: now.toISOString(),
  };
}

export function main(): number {
  writeText(stampPath, `${JSON.stringify(buildStamp(), null, 2)}\n`);
  // Progress goes to stderr so stdout stays data-only: this runs inside `npm run build`, and any
  // downstream `npm run build --silent && node … --json` command would otherwise inherit this line
  // on stdout and corrupt the JSON its consumer parses (same rule as generate-capability-matrix.ts).
  console.error(`Wrote ${rel(stampPath)}`);
  return 0;
}

// Use process.exitCode (not process.exit) to allow stdout to be flushed before exit.
// Resolve real paths to handle symlinks (e.g. /tmp -> /private/tmp on macOS) so the
// entry-point guard fires correctly when the module is loaded directly as a script.
const _selfRealPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const _argv1RealPath = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })();
if (_selfRealPath === _argv1RealPath) { process.exitCode = main(); }
