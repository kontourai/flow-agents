import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { loadRun, withRunMutationLock } from "@kontourai/flow";
import { assertDelegationFlowRuntime } from "@kontourai/flow-agents/delegation-flow-runtime";
import { DelegationAdmissionError } from "@kontourai/flow-agents/delegation-authority-service";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const runtime = { loadRun, withRunMutationLock };
const mismatch = error => error instanceof DelegationAdmissionError
  && error.code === "delegation_flow_runtime_mismatch";

test("public runtime assertion accepts actual shared Flow references without a success token", () => {
  assert.equal(assertDelegationFlowRuntime(runtime), undefined);
});

for (const field of ["loadRun", "withRunMutationLock"]) {
  test(`public runtime assertion rejects a different ${field} without invoking it`, () => {
    let invoked = 0;
    const foreign = () => { invoked++; throw new Error("must not run"); };
    assert.throws(() => assertDelegationFlowRuntime({ ...runtime, [field]: foreign }), mismatch);
    assert.equal(invoked, 0);
  });
}

test("public runtime assertion refuses absent and non-function witnesses with its closed error", () => {
  for (const input of [undefined, null, 1, {}, { loadRun }, { withRunMutationLock },
    { ...runtime, loadRun: "loadRun" }, { ...runtime, withRunMutationLock: null }]) {
    assert.throws(() => assertDelegationFlowRuntime(input), mismatch);
  }
});

test("a genuine second module copy at the same Flow version is not runtime-compatible", async t => {
  const root = makeFixtureDir("flow-runtime-copy-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifestPath = fs.realpathSync(findPackageJSON("@kontourai/flow", import.meta.url));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const original = path.dirname(manifestPath);
  const copy = path.join(root, "node_modules", "@kontourai", "flow");
  fs.mkdirSync(copy, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(copy, "package.json"));
  fs.cpSync(path.join(original, "dist"), path.join(copy, "dist"), { recursive: true });
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    const dependency = path.dirname(fs.realpathSync(findPackageJSON(name, pathToFileURL(manifestPath))));
    const link = path.join(copy, "node_modules", name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(dependency, link, process.platform === "win32" ? "junction" : "dir");
  }
  const entry = path.join(root, "host.mjs");
  fs.writeFileSync(entry, 'export { loadRun, withRunMutationLock } from "@kontourai/flow";\n');
  const foreign = await import(pathToFileURL(entry).href);
  assert.notEqual(foreign.loadRun, loadRun);
  assert.notEqual(foreign.withRunMutationLock, withRunMutationLock);
  assert.throws(() => assertDelegationFlowRuntime(foreign), mismatch);
});
