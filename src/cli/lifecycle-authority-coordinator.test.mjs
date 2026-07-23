import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COORDINATOR = path.resolve("packaging/lifecycle-authority/coordinator.mjs");
const RUNTIME = path.resolve("packaging/lifecycle-authority/runtime-v1.mjs");
const CURRENT_MANIFEST_BYTES = 4_288_259;
const EXPECTED_MANIFEST_BYTES = 16 * 1024 * 1024;

function writeProtectedManifest(directory, bytes) {
  const file = path.join(directory, `manifest-${bytes}.json`);
  const prefix = '{"evidence":[],"padding":"';
  const suffix = '"}';
  const paddingBytes = bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(paddingBytes >= 0, "fixture must have room for a JSON payload");
  fs.writeFileSync(file, `${prefix}${"x".repeat(paddingBytes)}${suffix}`, { mode: 0o600 });
  assert.equal(fs.statSync(file).size, bytes, "generated manifest has the requested byte size");
  return file;
}

async function loadProtectedReadFromCoordinator() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-coordinator-test-"));
  fs.copyFileSync(RUNTIME, path.join(directory, "runtime-v1.mjs"));
  const source = fs.readFileSync(COORDINATOR, "utf8");
  fs.writeFileSync(path.join(directory, "coordinator.mjs"), `${source}\nexport { protectedRegularFile };\n`);
  const module = await import(`${pathToFileURL(path.join(directory, "coordinator.mjs")).href}?test=${Date.now()}-${Math.random()}`);
  return { directory, protectedRegularFile: module.protectedRegularFile };
}

test("canonical Flow manifest declares and uses the isolated 16 MiB capacity", () => {
  const source = fs.readFileSync(COORDINATOR, "utf8");
  assert.ok(
    /(?:export\s+)?const\s+MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024\s*;/.test(source),
    "coordinator must declare the named 16 MiB canonical-manifest cap",
  );
  assert.ok(
    /protectedRegularFile\(\s*files\.manifest,\s*"canonical Flow evidence manifest",\s*MAX_CANONICAL_FLOW_MANIFEST_BYTES\s*\)/s.test(source),
    "coordinator must apply the named cap only to the canonical evidence manifest",
  );
});

test("current four MiB coordinator guard rejects the protected 4,288,259-byte canonical manifest", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const manifest = writeProtectedManifest(directory, CURRENT_MANIFEST_BYTES);
    assert.throws(
      () => protectedRegularFile(manifest, "canonical Flow evidence manifest", 4 * 1024 * 1024),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the named 16 MiB boundary admits protected valid manifests and rejects one byte over", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const currentScale = writeProtectedManifest(directory, CURRENT_MANIFEST_BYTES);
    const atLimit = writeProtectedManifest(directory, EXPECTED_MANIFEST_BYTES);
    const overLimit = writeProtectedManifest(directory, EXPECTED_MANIFEST_BYTES + 1);
    assert.doesNotThrow(() => JSON.parse(protectedRegularFile(currentScale, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")));
    assert.doesNotThrow(() => JSON.parse(protectedRegularFile(atLimit, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")));
    assert.throws(
      () => protectedRegularFile(overLimit, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the manifest boundary retains malformed JSON and writable-file rejection", async () => {
  const { directory, protectedRegularFile } = await loadProtectedReadFromCoordinator();
  try {
    const malformed = path.join(directory, "malformed.json");
    fs.writeFileSync(malformed, "{not-json", { mode: 0o600 });
    assert.throws(() => JSON.parse(protectedRegularFile(malformed, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES).toString("utf8")), SyntaxError);

    const writable = writeProtectedManifest(directory, 128);
    fs.chmodSync(writable, 0o622);
    assert.throws(
      () => protectedRegularFile(writable, "canonical Flow evidence manifest", EXPECTED_MANIFEST_BYTES),
      /canonical Flow evidence manifest must be a protected regular file/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
