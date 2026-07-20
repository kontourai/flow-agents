import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { canonicalJson, sha256, validateEnvelope } from "../../packaging/lifecycle-authority/coordinator.mjs";

const request = { action: "cancel", project_root: "/srv/project", session_dir: "/srv/project/.kontourai/flow-agents/run-1", authorization_file: "/etc/kontourai/request.json" };
const envelope = { schema_version: "1.0", action: "cancel", request_sha256: sha256(request), request };
test("reference coordinator canonicalization is order-independent", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.deepEqual(validateEnvelope(envelope), envelope);
});
test("reference coordinator rejects unknown fields actions and digest drift", () => {
  assert.throws(() => validateEnvelope({ ...envelope, extra: true }), /unexpected or missing/);
  assert.throws(() => validateEnvelope({ ...envelope, action: "delete" }), /unsupported/);
  assert.throws(() => validateEnvelope({ ...envelope, request_sha256: "0".repeat(64) }), /digest/);
  assert.throws(() => validateEnvelope({ ...envelope, request: { ...request, extra: true } }), /unexpected or missing/);
});
test("reference coordinator pins the published Flow reducer identity rather than local semantics", () => {
  const pin = JSON.parse(fs.readFileSync(new URL("../../packaging/lifecycle-authority/flow-reducer-v1.json", import.meta.url), "utf8"));
  assert.deepEqual(pin, {
    package: "@kontourai/flow",
    package_version: "3.5.0",
    release_commit: "871ed9c",
    reducer: {
      artifact_id: "kontourai.flow.trust-attachment-reducer",
      version: "1.0.0",
      dependency_versions: { hachure: "0.15.0", surface: "2.12.0" },
      hash: "sha256:389ef9d5d0995adcd74a8d51780b438e43d16a46dfb6d0882aad6010a1a2e0bd",
    },
  });
});
