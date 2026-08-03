import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { main as kitMain } from "../../build/src/cli/kit.js";
import { observeInstalledKitIntegrity } from "../../build/src/flow-kit/content-hash.js";

const FIXTURE = path.resolve("evals/fixtures/flow-kit-repository/valid-local-kit");
const CANONICAL_PATH = "kits/local/repositories/example-kit";

function tempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFixture(destination) {
  fs.cpSync(FIXTURE, destination, { recursive: true });
}

function readEntry(dest) {
  const registryPath = path.join(dest, "kits", "local", "installed-kits.json");
  return JSON.parse(fs.readFileSync(registryPath, "utf8")).kits[0];
}

async function captureMain(argv) {
  const output = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => output.push(args.join(" "));
  console.error = (...args) => output.push(args.join(" "));
  try {
    return { status: await kitMain(argv), output: output.join("\n") };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("local installs record portable paths and remain installed after the destination moves", async () => {
  const root = tempRoot("flow-kit-registry-portable-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  const movedDest = path.join(root, "moved-dest");
  copyFixture(source);

  const install = await captureMain([
    "install", source, "--dest", dest, "--record-source", "catalog:example-kit@v1",
  ]);
  assert.equal(install.status, 0, install.output);
  assert.match(install.output, /caller-declared source metadata/);
  const entry = readEntry(dest);
  assert.equal(entry.installed_path, CANONICAL_PATH);
  assert.equal(entry.source, "catalog:example-kit@v1");

  fs.cpSync(dest, movedDest, { recursive: true });
  const movedEntry = readEntry(movedDest);
  assert.equal(observeInstalledKitIntegrity(movedEntry, movedDest).state, "installed");
  const status = await captureMain(["status", "example-kit", "--dest", movedDest]);
  assert.equal(status.status, 0, status.output);
  assert.match(status.output, /"state": "installed"/);

  const replacementSource = path.join(root, "replacement-source");
  copyFixture(replacementSource);
  const idempotent = await captureMain([
    "install", replacementSource, "--dest", dest, "--record-source", "catalog:example-kit@v1",
  ]);
  assert.equal(idempotent.status, 0, idempotent.output);
  assert.match(idempotent.output, /already installed/);
});

test("integrity accepts only an exact legacy target for the current destination", async () => {
  const root = tempRoot("flow-kit-registry-legacy-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  const copiedDest = path.join(root, "copied-dest");
  copyFixture(source);
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);
  const entry = readEntry(dest);
  const legacyEntry = {
    ...entry,
    installed_path: path.join(dest, "kits", "local", "repositories", "example-kit"),
  };
  assert.equal(observeInstalledKitIntegrity(legacyEntry, dest).state, "installed");

  fs.cpSync(dest, copiedDest, { recursive: true });
  const crossCheckout = observeInstalledKitIntegrity(legacyEntry, copiedDest);
  assert.equal(crossCheckout.state, "invalid");
  assert.match(crossCheckout.diagnostic, /canonical relative path/);
});

test("integrity rejects alternate paths without resolving registry-supplied targets", async () => {
  const root = tempRoot("flow-kit-registry-invalid-path-");
  const source = path.join(root, "source");
  const dest = path.join(root, "dest");
  copyFixture(source);
  assert.equal(await kitMain(["install", source, "--dest", dest]), 0);
  const entry = readEntry(dest);
  for (const installed_path of [
    "./kits/local/repositories/example-kit",
    "kits/local/repositories/../repositories/example-kit",
    "../kits/local/repositories/example-kit",
    "kits\\local\\repositories\\example-kit",
    path.join(root, "other-checkout", "kits", "local", "repositories", "example-kit"),
    "kits/local/repositories/example-kit\u0000suffix",
  ]) {
    const integrity = observeInstalledKitIntegrity({ ...entry, installed_path }, dest);
    assert.equal(integrity.state, "invalid", installed_path);
  }
});

test("record-source is bounded caller-declared local metadata and Git rejects it", async () => {
  const root = tempRoot("flow-kit-record-source-");
  const source = path.join(root, "source");
  copyFixture(source);
  for (const invalidSource of ["", "   ", " leading", "trailing ", "line\nbreak", "x".repeat(1025)]) {
    const result = await captureMain([
      "install", source, "--dest", path.join(root, `dest-${invalidSource.length}`), "--record-source", invalidSource,
    ]);
    assert.equal(result.status, 2, invalidSource || "empty");
    assert.match(result.output, /--record-source must be a trimmed non-blank locator/);
  }
  const gitResult = await captureMain([
    "install", "https://example.invalid/example-kit.git", "--record-source", "logical:example-kit",
  ]);
  assert.equal(gitResult.status, 2, gitResult.output);
  assert.match(gitResult.output, /only for local path installs/);
});
