// The bundle pack and the resolver that expands it (kontourai/flow-agents#1616). The published package ships the install bundles as
// one pack; these tests prove the pack round-trips what the builder wrote, refuses anything damaged BEFORE writing, and that the
// resolver never writes into the package and cleans up after itself.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  BUNDLE_PACK_MAGIC,
  BUNDLE_PACK_RELATIVE_PATH,
  BundlePackError,
  assertPackPath,
  buildBundlePack,
  extractBundlePack,
  readBundlePackHeader,
} from "../../build/src/lib/bundle-pack.js";
import { isExpandedBundle, releaseExpandedBundles, resolveBundle, resolveDistFile } from "../../build/src/lib/bundle-store.js";

const PKG = { name: "@kontourai/flow-agents", version: "0.0.0-test" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bundle-pack-test-"));
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** A miniature dist/: two harnesses that share a file, one executable, plus the root files. */
function fixtureDist(dir) {
  const put = (relative, content, mode = 0o644) => {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
  };
  const shared = "shared module ".repeat(500);
  for (const harness of ["codex", "claude-code"]) {
    put(`${harness}/install.sh`, `#!/bin/sh\necho ${harness}\n`, 0o755);
    put(`${harness}/build/src/shared.js`, shared);
    put(`${harness}/README.md`, `${harness} only\n`);
  }
  put("catalog.json", '{"bundles":["codex","claude-code"]}\n');
  return dir;
}

function packFixture() {
  const scratch = tmp();
  const dist = fixtureDist(path.join(scratch, "dist"));
  const built = buildBundlePack(dist, PKG);
  const packFile = path.join(scratch, "fixture.pack");
  fs.writeFileSync(packFile, built.bytes);
  return { scratch, dist, packFile, built };
}

test("a pack round-trips every file byte for byte, with modes, and stores shared content once", () => {
  const { scratch, dist, packFile, built } = packFixture();
  try {
    assert.equal(built.header.entries.length, 7);
    assert.equal(built.header.blobs.length, 6, "the identical shared.js is one blob");
    assert.ok(built.distinctRawBytes < built.rawBytes);
    const out = path.join(scratch, "out");
    const written = extractBundlePack(packFile, out);
    assert.equal(written.length, 7);
    for (const entry of built.header.entries) {
      assert.equal(sha(path.join(out, entry.path)), sha(path.join(dist, entry.path)), entry.path);
      assert.equal(fs.statSync(path.join(out, entry.path)).mode & 0o777, entry.mode, `${entry.path} mode`);
    }
    assert.equal(fs.statSync(path.join(out, "codex/install.sh")).mode & 0o111, 0o111);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("extracting a named harness writes that harness (and named root files) only", () => {
  const { scratch, packFile } = packFixture();
  try {
    const out = path.join(scratch, "out");
    extractBundlePack(packFile, out, ["codex", "catalog.json"]);
    assert.ok(fs.existsSync(path.join(out, "codex/install.sh")));
    assert.ok(fs.existsSync(path.join(out, "catalog.json")));
    assert.ok(!fs.existsSync(path.join(out, "claude-code")));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("reading the header needs no decompression and reports the package", () => {
  const { scratch, packFile, built } = packFixture();
  try {
    const header = readBundlePackHeader(packFile);
    assert.deepEqual(header.package, PKG);
    assert.equal(header.digest, built.header.digest);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("a damaged pack is refused before anything is written, whichever harness is asked for", () => {
  const { scratch, packFile } = packFixture();
  try {
    const good =fs.readFileSync(packFile);
    const bodyStart = BUNDLE_PACK_MAGIC.length + 4 + good.readUInt32BE(BUNDLE_PACK_MAGIC.length);
    const damages = {
      "flipped body byte": (bytes) => { bytes[bytes.length - 8] ^= 0xff; return bytes; },
      "truncated body": (bytes) => bytes.subarray(0, bodyStart + Math.floor((bytes.length - bodyStart) / 2)),
      "truncated header": (bytes) => bytes.subarray(0, bodyStart - 10),
      "bad magic": (bytes) => { bytes[0] ^= 0xff; return bytes; },
      "body removed": (bytes) => bytes.subarray(0, bodyStart),
    };
    for (const [label, damage] of Object.entries(damages)) {
      const damaged = path.join(scratch, `damaged-${label.replaceAll(" ", "-")}.pack`);
      fs.writeFileSync(damaged, damage(Buffer.from(good)));
      for (const names of [["codex"], ["claude-code"], "*"]) {
        const out = path.join(scratch, `out-${label.replaceAll(" ", "-")}-${Array.isArray(names) ? names[0] : "all"}`);
        assert.throws(() => extractBundlePack(damaged, out, names), BundlePackError, `${label} / ${JSON.stringify(names)}`);
        assert.ok(!fs.existsSync(out), `${label}: nothing may be written for a damaged pack`);
      }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("a pack whose manifest was edited is refused (digest covers entries and blobs)", () => {
  const { scratch, packFile } = packFixture();
  try {
    const bytes = fs.readFileSync(packFile);
    const length = bytes.readUInt32BE(BUNDLE_PACK_MAGIC.length);
    const headerStart = BUNDLE_PACK_MAGIC.length + 4;
    const header = JSON.parse(bytes.subarray(headerStart, headerStart + length).toString("utf8"));
    header.entries[0].mode = header.entries[0].mode === 0o755 ? 0o644 : 0o755;
    const edited = Buffer.from(JSON.stringify(header), "utf8");
    const prefix = Buffer.alloc(headerStart);
    prefix.write(BUNDLE_PACK_MAGIC, "ascii");
    prefix.writeUInt32BE(edited.length, BUNDLE_PACK_MAGIC.length);
    const forged = path.join(scratch, "forged.pack");
    fs.writeFileSync(forged, Buffer.concat([prefix, edited, bytes.subarray(headerStart + length)]));
    assert.throws(() => extractBundlePack(forged, path.join(scratch, "out")), /digest does not match its manifest/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("paths that could escape the target or name an unknown root are rejected", () => {
  for (const bad of ["../evil", "codex/../../evil", "/abs/path", "codex//x", "codex/./x", "codex\\x", "codex/\u0000x", "", "unknown/file", "codex", "catalog.json.bak"]) {
    assert.throws(() => assertPackPath(bad), BundlePackError, JSON.stringify(bad));
  }
  for (const good of ["codex/install.sh", "base/a/b/c.js", "catalog.json", "README.md"]) assert.doesNotThrow(() => assertPackPath(good));
});

test("the builder refuses symlinks and an empty dist", () => {
  const scratch = tmp();
  try {
    assert.throws(() => buildBundlePack(path.join(scratch, "empty"), PKG), /ENOENT|no bundle files/);
    const dist = fixtureDist(path.join(scratch, "dist"));
    fs.symlinkSync("/etc/hosts", path.join(dist, "codex", "link"));
    assert.throws(() => buildBundlePack(dist, PKG), /symlink/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("only the current owner's exact lock metadata is excluded from a snapshot", () => {
  const scratch = tmp();
  try {
    const dist = fixtureDist(path.join(scratch, "dist"));
    const expected = buildBundlePack(dist, PKG).header.digest;
    const lock = path.join(dist, ".build-lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), `${process.pid}\n`);
    assert.throws(() => buildBundlePack(dist, PKG), /known bundle roots/);
    const packed = buildBundlePack(dist, PKG, lock);
    assert.equal(packed.header.digest, expected);
    assert.ok(packed.header.entries.every(entry => !entry.path.startsWith(".build-lock/")));
    fs.writeFileSync(path.join(lock, "extra"), "not metadata");
    assert.throws(() => buildBundlePack(dist, PKG, lock), /not owned/);
    fs.unlinkSync(path.join(lock, "extra"));
    fs.writeFileSync(path.join(lock, "pid"), "0\n");
    assert.throws(() => buildBundlePack(dist, PKG, lock), /not owned/);
    fs.rmSync(lock, { recursive: true });
    fs.symlinkSync(path.join(dist, "codex"), lock);
    assert.throws(() => buildBundlePack(dist, PKG, lock), /not owned/);
    fs.unlinkSync(lock);
    fs.mkdirSync(path.join(dist, ".unexpected"));
    assert.throws(() => buildBundlePack(dist, PKG), /known bundle roots/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("extract refuses to overwrite an existing file", () => {
  const { scratch, packFile } = packFixture();
  try {
    const out = path.join(scratch, "out");
    extractBundlePack(packFile, out, ["codex"]);
    assert.throws(() => extractBundlePack(packFile, out, ["codex"]), /EEXIST/);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// -- the resolver -----------------------------------------------------------------------------------------------------------

function packageWithPack() {
  const scratch = tmp();
  const dist = fixtureDist(path.join(scratch, "fixture-dist"));
  const pkg = path.join(scratch, "package");
  fs.mkdirSync(path.join(pkg, "bundles"), { recursive: true });
  fs.writeFileSync(path.join(pkg, BUNDLE_PACK_RELATIVE_PATH), buildBundlePack(dist, PKG).bytes);
  return { scratch, pkg, dist };
}
const snapshot = (dir) => fs.readdirSync(dir, { recursive: true }).sort().join("\n");

test("resolveBundle expands from the pack into a private temp directory and never writes the package", () => {
  const { scratch, pkg } = packageWithPack();
  const before = snapshot(pkg);
  try {
    const resolved = resolveBundle("codex", pkg);
    assert.ok(resolved?.fromPack);
    assert.ok(fs.existsSync(path.join(resolved.dir, "install.sh")));
    assert.ok(isExpandedBundle(resolved.dir));
    assert.ok(!path.resolve(resolved.dir).startsWith(path.resolve(pkg)), "expanded outside the package");
    assert.equal(fs.statSync(path.dirname(resolved.dir)).mode & 0o077, 0, "private directory");
    assert.ok(fs.existsSync(path.join(path.dirname(resolved.dir), "catalog.json")), "catalog.json rides along with the first harness");
    assert.equal(resolveBundle("codex", pkg)?.dir, resolved.dir, "a second ask reuses the expansion");
    assert.equal(snapshot(pkg), before, "the package directory is unchanged");
    const parent = path.dirname(resolved.dir);
    releaseExpandedBundles();
    assert.ok(!fs.existsSync(parent), "released expansions are removed");
    assert.ok(!isExpandedBundle(resolved.dir));
  } finally { releaseExpandedBundles(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("a built dist/ takes precedence over the pack and is not marked as expanded", () => {
  const { scratch, pkg, dist } = packageWithPack();
  try {
    fs.cpSync(dist, path.join(pkg, "dist"), { recursive: true });
    const resolved = resolveBundle("codex", pkg);
    assert.equal(resolved?.fromPack, false);
    assert.equal(resolved?.dir, path.join(pkg, "dist", "codex"));
    assert.ok(!isExpandedBundle(resolved.dir));
    assert.equal(resolveDistFile("catalog.json", pkg), path.join(pkg, "dist", "catalog.json"));
  } finally { releaseExpandedBundles(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("a package with neither dist/ nor a pack resolves to null, and a damaged pack throws", () => {
  const { scratch, pkg } = packageWithPack();
  try {
    const empty = path.join(scratch, "empty-package");
    fs.mkdirSync(empty);
    assert.equal(resolveBundle("codex", empty), null);
    assert.equal(resolveDistFile("catalog.json", empty), null);
    const packFile = path.join(pkg, BUNDLE_PACK_RELATIVE_PATH);
    const bytes = fs.readFileSync(packFile);
    bytes[bytes.length - 8] ^= 0xff;
    fs.writeFileSync(packFile, bytes);
    assert.throws(() => resolveBundle("codex", pkg), BundlePackError);
  } finally { releaseExpandedBundles(); fs.rmSync(scratch, { recursive: true, force: true }); }
});

test("the resolver serves a harness the pack lacks as an empty directory result, not a crash", () => {
  const { scratch, pkg } = packageWithPack();
  try {
    const resolved = resolveBundle("pi", pkg);
    assert.ok(resolved?.fromPack);
    assert.ok(!fs.existsSync(path.join(resolved.dir, "install.sh")), "callers check install.sh and report a missing bundle");
  } finally { releaseExpandedBundles(); fs.rmSync(scratch, { recursive: true, force: true }); }
});
