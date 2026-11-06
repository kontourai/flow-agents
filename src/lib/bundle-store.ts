/**
 * Where the install bundles come from (kontourai/flow-agents#1616).
 *
 * In a source checkout, `npm run build:bundles` writes them to `dist/` and everything reads them there. The published package does
 * not ship `dist/`; it ships one bundle pack (see bundle-pack.ts). A command that needs a harness bundle asks here, and gets:
 *
 *   1. `<package>/dist/<harness>` when it is built (a checkout, or an install someone expanded by hand); or
 *   2. the harness expanded from the pack into a private temporary directory that exists for the life of this process and is
 *      removed when it ends. Every file is checked against the pack's SHA-256 before it is written. Nothing is compiled, nothing is
 *      downloaded, and the package directory is never written to (it may be read-only, or shared by several users).
 *
 * A package with neither returns null and the caller reports it in its own words.
 *
 * @module bundle-store
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { root as defaultRoot } from "../tools/common.js";
import { BUNDLE_PACK_RELATIVE_PATH, extractBundlePack } from "./bundle-pack.js";

export interface ResolvedBundle {
  /** The harness bundle directory (`install.sh`, `build/`, `scripts/`, ...). */
  dir: string;
  /** True when it was expanded from the pack, so there is no `dist/` in the package to lock or rebuild. */
  fromPack: boolean;
}

interface Session { dir: string; expanded: Set<string> }
const sessions = new Map<string, Session>();
let cleanupRegistered = false;

function removeSessions(): void {
  for (const session of sessions.values()) fs.rmSync(session.dir, { recursive: true, force: true });
  sessions.clear();
}

/** Remove every directory expanded so far. Called when the process exits, and by tests. */
export function releaseExpandedBundles(): void {
  removeSessions();
}

function session(packageRoot: string): Session {
  const existing = sessions.get(packageRoot);
  if (existing) return existing;
  // mkdtemp creates the directory with mode 0700, owned by this user, under a name nobody else can predict.
  const created: Session = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-bundles-")), expanded: new Set() };
  sessions.set(packageRoot, created);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.on("exit", removeSessions);
  }
  return created;
}

export function bundlePackPath(packageRoot: string = defaultRoot): string {
  return path.join(packageRoot, BUNDLE_PACK_RELATIVE_PATH);
}

/** Whether `dir` is inside a private expansion that a checkout builder cannot reset. */
export function isExpandedBundle(dir: string): boolean {
  const resolved = path.resolve(dir);
  return [...sessions.values()].some((session) => resolved === session.dir || resolved.startsWith(session.dir + path.sep));
}

/** The package's built `dist/<harness>`, when it has one. */
function builtBundle(harness: string, packageRoot: string): string | null {
  const dir = path.join(packageRoot, "dist", harness);
  return fs.existsSync(path.join(dir, "install.sh")) ? dir : null;
}

function expand(names: string[], packageRoot: string): Session | null {
  const pack = bundlePackPath(packageRoot);
  if (!fs.existsSync(pack)) return null;
  const current = session(packageRoot);
  const missing = names.filter((name) => !current.expanded.has(name));
  if (missing.length > 0) {
    extractBundlePack(pack, current.dir, missing);
    for (const name of missing) current.expanded.add(name);
  }
  return current;
}

/** The bundle for one harness (`codex`, `claude-code`, `base`, ...), or null when the package carries neither `dist/` nor a pack. */
export function resolveBundle(harness: string, packageRoot: string = defaultRoot): ResolvedBundle | null {
  const built = builtBundle(harness, packageRoot);
  if (built) return { dir: built, fromPack: false };
  // catalog.json sits beside the harness directories and `uninstall` reads it from there, so it comes with the first harness.
  const expanded = expand([harness, "catalog.json"], packageRoot);
  return expanded ? { dir: path.join(expanded.dir, harness), fromPack: true } : null;
}

/** A file that sits beside the harness bundles (`catalog.json`), or null when the package has none. */
export function resolveDistFile(name: "catalog.json" | "README.md", packageRoot: string = defaultRoot): string | null {
  const built = path.join(packageRoot, "dist", name);
  if (fs.existsSync(built)) return built;
  const expanded = expand([name], packageRoot);
  return expanded ? path.join(expanded.dir, name) : null;
}
