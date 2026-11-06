/**
 * The bundle pack: how the install bundles travel in the published package (kontourai/flow-agents#1616).
 *
 * `build:bundles` writes one full tree per harness under `dist/` (base, kiro, claude-code, codex, opencode, pi). Those trees share
 * most of their bytes, and a host that only imports the package never reads them, but they were 95% of what npm unpacked. The
 * published package now carries ONE file instead: every distinct file stored once, in a single compressed stream, with a manifest
 * that says which path holds which content. `init`, `kit`, `workflow doctor` and `uninstall` expand the harness they need into a
 * private temporary directory and read it exactly as they read `dist/` in a checkout.
 *
 * Nothing is compiled or downloaded on the consumer's machine: the bytes written are the bytes the publisher built, and each file
 * is checked against its SHA-256 before it is written.
 *
 * File layout (all integers big-endian):
 *
 *   8 bytes   magic "FABPACK1"
 *   4 bytes   length of the header
 *   n bytes   header, UTF-8 JSON: { format, package: { name, version }, entries: [{ path, mode, blob }], blobs: [{ sha256, size }], digest }
 *   rest      one Brotli stream: the blobs, concatenated in header order
 *
 * `digest` is the SHA-256 of the entries and blobs lists, so two packs hold the same files exactly when their digests agree.
 *
 * @module bundle-pack
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const BUNDLE_PACK_MAGIC = "FABPACK1";
/** Path of the pack inside the published package. */
export const BUNDLE_PACK_RELATIVE_PATH = "bundles/flow-agents-bundles.pack";
/** The top-level entries a pack may hold: one directory per harness bundle and the two files that sit beside them. */
export const BUNDLE_PACK_ROOTS = ["base", "kiro", "claude-code", "codex", "opencode", "pi"] as const;
export const BUNDLE_PACK_ROOT_FILES = ["catalog.json", "README.md"] as const;

const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

export interface BundlePackEntry { path: string; mode: number; blob: number }
export interface BundlePackBlob { sha256: string; size: number }
export interface BundlePackHeader {
  format: 1;
  package: { name: string; version: string };
  entries: BundlePackEntry[];
  blobs: BundlePackBlob[];
  digest: string;
}

export class BundlePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundlePackError";
  }
}

const sha256 = (data: Uint8Array | string): string => crypto.createHash("sha256").update(data).digest("hex");
const digestOf = (entries: BundlePackEntry[], blobs: BundlePackBlob[]): string => `sha256:${sha256(JSON.stringify({ entries, blobs }))}`;

/** A path a pack may contain: relative, POSIX, no `.`/`..`/empty segment, no backslash or control character, under a known root. */
export function assertPackPath(entryPath: string): void {
  const segments = entryPath.split("/");
  const unsafe = entryPath === "" || entryPath.startsWith("/") || /[\\\u0000-\u001f]/.test(entryPath) || segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (unsafe) throw new BundlePackError(`bundle pack path is not a safe relative path: ${JSON.stringify(entryPath)}`);
  const top = segments[0] as string;
  const known = (BUNDLE_PACK_ROOTS as readonly string[]).includes(top) ? segments.length > 1 : (BUNDLE_PACK_ROOT_FILES as readonly string[]).includes(entryPath);
  if (!known) throw new BundlePackError(`bundle pack path is outside the known bundle roots: ${JSON.stringify(entryPath)}`);
}

function listFiles(distDir: string, ownedLock?: string): string[] {
  const found: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (!prefix && entry.name === ".build-lock" && ownedLock === absolute) {
        if (!entry.isDirectory() || fs.readdirSync(absolute).join() !== "pid" ||
            !fs.lstatSync(path.join(absolute, "pid")).isFile() ||
            fs.readFileSync(path.join(absolute, "pid"), "utf8").trim() !== String(process.pid)) {
          throw new BundlePackError("bundle build lock is not owned by this process");
        }
        continue;
      }
      if (entry.isSymbolicLink()) throw new BundlePackError(`bundle contains a symlink, which a pack does not carry: dist/${relative}`);
      if (!prefix && !(BUNDLE_PACK_ROOTS as readonly string[]).includes(entry.name) && !(BUNDLE_PACK_ROOT_FILES as readonly string[]).includes(entry.name)) throw new BundlePackError(`bundle pack path is outside the known bundle roots: ${JSON.stringify(relative)}`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) found.push(relative);
      else throw new BundlePackError(`bundle contains a non-regular entry: dist/${relative}`);
    }
  };
  visit(distDir, "");
  return found.sort();
}

/** Pack every file of `distDir` (the built bundles). Returns the bytes and a summary; the caller decides where to write them. */
export function buildBundlePack(distDir: string, pkg: { name: string; version: string }, ownedLock?: string): { bytes: Buffer; header: BundlePackHeader; rawBytes: number; distinctRawBytes: number } {
  const files = listFiles(distDir, ownedLock);
  const blobIndex = new Map<string, number>();
  const blobs: BundlePackBlob[] = [];
  const contents: Buffer[] = [];
  const entries: BundlePackEntry[] = [];
  let rawBytes = 0;
  for (const relative of files) {
    assertPackPath(relative);
    const absolute = path.join(distDir, ...relative.split("/"));
    const data = fs.readFileSync(absolute);
    const mode = fs.statSync(absolute).mode & 0o111 ? 0o755 : 0o644;
    const hash = sha256(data);
    let index = blobIndex.get(hash);
    if (index === undefined) {
      index = blobs.length;
      blobIndex.set(hash, index);
      blobs.push({ sha256: hash, size: data.length });
      contents.push(data);
    }
    entries.push({ path: relative, mode, blob: index });
    rawBytes += data.length;
  }
  if (entries.length === 0) throw new BundlePackError(`no bundle files found under ${distDir}; run npm run build:bundles first`);
  const header: BundlePackHeader = { format: 1, package: pkg, entries, blobs, digest: digestOf(entries, blobs) };
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const stream = zlib.brotliCompressSync(Buffer.concat(contents), {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: contents.reduce((sum, item) => sum + item.length, 0),
    },
  });
  const prefix = Buffer.alloc(BUNDLE_PACK_MAGIC.length + 4);
  prefix.write(BUNDLE_PACK_MAGIC, "ascii");
  prefix.writeUInt32BE(headerBytes.length, BUNDLE_PACK_MAGIC.length);
  return { bytes: Buffer.concat([prefix, headerBytes, stream]), header, rawBytes, distinctRawBytes: blobs.reduce((sum, blob) => sum + blob.size, 0) };
}

function parseHeader(file: Buffer): { header: BundlePackHeader; bodyOffset: number } {
  const fixed = BUNDLE_PACK_MAGIC.length + 4;
  if (file.length < fixed || file.subarray(0, BUNDLE_PACK_MAGIC.length).toString("ascii") !== BUNDLE_PACK_MAGIC) throw new BundlePackError("not a Flow Agents bundle pack (bad magic)");
  const headerLength = file.readUInt32BE(BUNDLE_PACK_MAGIC.length);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES || fixed + headerLength > file.length) throw new BundlePackError("bundle pack header is truncated or oversize");
  let header: BundlePackHeader;
  try {
    header = JSON.parse(file.subarray(fixed, fixed + headerLength).toString("utf8")) as BundlePackHeader;
  } catch {
    throw new BundlePackError("bundle pack header is not valid JSON");
  }
  if (header?.format !== 1 || !Array.isArray(header.entries) || !Array.isArray(header.blobs) || typeof header.digest !== "string") throw new BundlePackError("bundle pack header has an unknown shape");
  if (header.entries.length > MAX_ENTRIES || header.blobs.length > MAX_ENTRIES) throw new BundlePackError("bundle pack lists too many files");
  let total = 0;
  for (const blob of header.blobs) {
    if (typeof blob?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(blob.sha256) || !Number.isSafeInteger(blob.size) || blob.size < 0) throw new BundlePackError("bundle pack lists a malformed blob");
    total += blob.size;
  }
  if (total > MAX_TOTAL_BYTES) throw new BundlePackError("bundle pack is larger than the size it may expand to");
  for (const entry of header.entries) {
    if (typeof entry?.path !== "string" || !Number.isInteger(entry.blob) || entry.blob < 0 || entry.blob >= header.blobs.length || (entry.mode !== 0o644 && entry.mode !== 0o755)) throw new BundlePackError("bundle pack lists a malformed entry");
    assertPackPath(entry.path);
  }
  if (digestOf(header.entries, header.blobs) !== header.digest) throw new BundlePackError("bundle pack digest does not match its manifest");
  return { header, bodyOffset: fixed + headerLength };
}

/** Read only the manifest of a pack (no decompression). */
export function readBundlePackHeader(packFile: string): BundlePackHeader {
  return parseHeader(fs.readFileSync(packFile)).header;
}

/** Whether `entryPath` belongs to one of `names` (a harness directory, or a root file by its name). */
function selected(entryPath: string, names: readonly string[]): boolean {
  const top = entryPath.split("/")[0] as string;
  return names.includes(top) || names.includes(entryPath);
}

/**
 * Expand parts of a pack into `targetDir`: each harness named in `names` (and the root files `catalog.json` / `README.md` when
 * named, or `"*"` for everything). Every file is checked against its recorded SHA-256 before it is written, the target is
 * created fresh and never merged into, and nothing outside it is touched. Returns the paths written.
 */
export function extractBundlePack(packFile: string, targetDir: string, names: readonly string[] | "*" = "*"): string[] {
  const file = fs.readFileSync(packFile);
  const { header, bodyOffset } = parseHeader(file);
  const expected = header.blobs.reduce((sum, blob) => sum + blob.size, 0);
  let body: Buffer;
  try {
    body = zlib.brotliDecompressSync(file.subarray(bodyOffset), { maxOutputLength: expected + 1 });
  } catch {
    throw new BundlePackError("bundle pack body is corrupt");
  }
  if (body.length !== expected) throw new BundlePackError("bundle pack body does not match its manifest");
  const offsets: number[] = [];
  let cursor = 0;
  for (const blob of header.blobs) {
    offsets.push(cursor);
    cursor += blob.size;
  }
  // Brotli carries no checksum, and damage can leave the stream decodable. Check EVERY blob, not just the requested ones, and do it
  // before the first write, so a damaged pack is refused whichever harness was asked for and leaves nothing behind.
  const owners = new Map<number, string>();
  for (const entry of header.entries) if (!owners.has(entry.blob)) owners.set(entry.blob, entry.path);
  header.blobs.forEach((blob, index) => {
    const start = offsets[index] as number;
    if (sha256(body.subarray(start, start + blob.size)) !== blob.sha256) throw new BundlePackError(`bundle pack content does not match its recorded digest: ${owners.get(index) ?? `blob ${index}`}`);
  });
  const wanted = names === "*" ? header.entries : header.entries.filter((entry) => selected(entry.path, names));
  const written: string[] = [];
  const root = path.resolve(targetDir);
  for (const entry of wanted) {
    const blob = header.blobs[entry.blob] as BundlePackBlob;
    const data = body.subarray(offsets[entry.blob] as number, (offsets[entry.blob] as number) + blob.size);
    const destination = path.resolve(root, ...entry.path.split("/"));
    if (destination !== root && !destination.startsWith(root + path.sep)) throw new BundlePackError(`bundle pack path escapes its target: ${entry.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data, { mode: entry.mode, flag: "wx" });
    fs.chmodSync(destination, entry.mode);
    written.push(entry.path);
  }
  return written;
}
