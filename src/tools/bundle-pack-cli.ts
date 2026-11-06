#!/usr/bin/env node
/**
 * bundle-pack-cli: write, inspect and expand the bundle pack (kontourai/flow-agents#1616).
 *
 *   node build/src/tools/bundle-pack-cli.js pack                      pack dist/ into bundles/flow-agents-bundles.pack (run by prepack)
 *   node build/src/tools/bundle-pack-cli.js info [pack]               print what a pack holds
 *   node build/src/tools/bundle-pack-cli.js extract <dir> [name...]   expand harnesses (or everything) into a new directory
 *
 * `pack` refuses to run unless dist/ holds every harness bundle, so a pack can never ship with one missing.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_PACK_ROOTS, BundlePackError, buildBundlePack, extractBundlePack, readBundlePackHeader } from "../lib/bundle-pack.js";
import { bundlePackPath } from "../lib/bundle-store.js";
import { loadJson, root } from "./common.js";
import { acquireBundleBuildLock, releaseBundleBuildLock, startBundleBuildLockRefresher } from "./build-universal-bundles.js";

/** Pack while the caller holds the canonical build lock. */
export function packUnderBundleBuildLock(lock: string): number {
  const canonicalLock = path.join(root, "dist", ".build-lock");
  if (lock !== canonicalLock || !fs.lstatSync(lock).isDirectory() || fs.readFileSync(path.join(lock, "pid"), "utf8").trim() !== String(process.pid)) throw new BundlePackError("bundle build lock is not owned by this process");
  const dist = process.env.FLOW_AGENTS_DIST_DIR ? path.resolve(process.env.FLOW_AGENTS_DIST_DIR) : path.join(root, "dist");
  for (const harness of BUNDLE_PACK_ROOTS) {
    if (!fs.existsSync(path.join(dist, harness, "install.sh"))) throw new BundlePackError(`dist/${harness} is not built; run npm run build:bundles first`);
  }
  const manifest = loadJson<{ name: string; version: string }>(path.join(root, "package.json"));
  const { bytes, header, rawBytes, distinctRawBytes } = buildBundlePack(dist, { name: manifest.name, version: manifest.version }, lock);
  const out = bundlePackPath(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(`${out}.tmp`, bytes);
  fs.renameSync(`${out}.tmp`, out);
  console.log(`Packed ${header.entries.length} files (${rawBytes} bytes across harness trees, ${distinctRawBytes} distinct) into ${path.relative(root, out)}: ${bytes.length} bytes`);
  console.log(`digest ${header.digest}`);
  return 0;
}

function pack(): number {
  const lock = acquireBundleBuildLock();
  const stop = startBundleBuildLockRefresher(lock);
  try { return packUnderBundleBuildLock(lock); }
  finally { stop(); releaseBundleBuildLock(lock); }
}

function info(file?: string): number {
  const header = readBundlePackHeader(file ?? bundlePackPath(root));
  const perHarness = new Map<string, { files: number; bytes: number }>();
  for (const entry of header.entries) {
    const top = entry.path.includes("/") ? (entry.path.split("/")[0] as string) : "(root files)";
    const row = perHarness.get(top) ?? { files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += (header.blobs[entry.blob] as { size: number }).size;
    perHarness.set(top, row);
  }
  console.log(JSON.stringify({ package: header.package, digest: header.digest, files: header.entries.length, distinct_blobs: header.blobs.length, distinct_bytes: header.blobs.reduce((sum, blob) => sum + blob.size, 0), harnesses: Object.fromEntries([...perHarness].sort()) }, null, 2));
  return 0;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  try {
    if (command === "pack") return pack();
    if (command === "info") return info(rest[0]);
    if (command === "extract" && rest[0]) {
      const target = path.resolve(rest[0]);
      if (fs.existsSync(target) && fs.readdirSync(target).length > 0) throw new BundlePackError(`${target} is not empty; extract into a new directory`);
      const written = extractBundlePack(bundlePackPath(root), target, rest.length > 1 ? rest.slice(1) : "*");
      console.log(`Expanded ${written.length} files into ${target}`);
      return 0;
    }
  } catch (error) {
    console.error(`bundle-pack: ${(error as Error).message}`);
    return 1;
  }
  console.error("usage: bundle-pack-cli.js pack | info [pack] | extract <dir> [name...]");
  return 2;
}

const selfPath = (() => { try { return fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); } })();
const entryPath = (() => { try { return fs.realpathSync(process.argv[1] ?? ""); } catch { return process.argv[1]; } })();
if (selfPath === entryPath) process.exitCode = main(process.argv.slice(2));
