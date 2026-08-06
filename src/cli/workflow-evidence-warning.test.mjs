import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { warnIfEvidenceCommandUnreconcilable } from "../../build/src/cli/workflow.js";

// #1056: `publish-delivery` refuses a command claim that is not in the CI reconcile manifest. That
// refusal is correct; discovering it at publish time is not, because the run is `completed` by then
// and an earlier step's expectation can no longer be rebound. These pin the record-time warning
// that makes the problem visible while the owning step can still fix it.
//
// It is ADVISORY. Every case below asserts it never throws — a warning that can fail a recording
// would be worse than the late refusal it exists to pre-empt.

function projectWithManifest(commands) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-warn-"));
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "warn-fixture",
      "trust-reconcile-manifest": commands.map((command, index) => ({ id: `check-${index}`, command })),
    }),
  );
  return root;
}

function captureStderr(fn) {
  const original = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk) => { captured += String(chunk); return true; };
  try { fn(); } finally { process.stderr.write = original; }
  return captured;
}

test("#1056: warns on a command that is not in the reconcile manifest", () => {
  const root = projectWithManifest(["npm run check:boundary --"]);
  // The exact mistake that stranded two complete evidence sets: a measurement recorded as a
  // command claim. It is accepted at `execute` and fatal at `publish-delivery`.
  const out = captureStderr(() => warnIfEvidenceCommandUnreconcilable(["git diff --stat origin/main...HEAD"], root));
  assert.match(out, /not in the CI reconcile manifest/);
  assert.match(out, /git diff --stat origin\/main\.\.\.HEAD/);
  assert.match(out, /publish-delivery/, "the warning must name the step that will refuse it");
  assert.match(out, /--summary/, "and the remedy, since the operator can still act here");
});

test("#1056: stays silent for a declared manifest command", () => {
  const root = projectWithManifest(["node --test evals/integration/some.test.mjs", "npm run check:boundary --"]);
  const out = captureStderr(() => warnIfEvidenceCommandUnreconcilable(["node --test evals/integration/some.test.mjs"], root));
  assert.equal(out, "", "a reconcilable command must produce no noise");
});

test("#1056: normalizes whitespace before judging", () => {
  const root = projectWithManifest(["node --test evals/integration/some.test.mjs"]);
  const out = captureStderr(() => warnIfEvidenceCommandUnreconcilable(["node   --test  evals/integration/some.test.mjs"], root));
  assert.equal(out, "", "collapsed whitespace is the same declared command");
});

test("#1056: warns only about the unreconcilable commands in a mixed set", () => {
  const root = projectWithManifest(["npm run check:boundary --"]);
  const out = captureStderr(() =>
    warnIfEvidenceCommandUnreconcilable(["npm run check:boundary --", "git diff --stat"], root));
  assert.match(out, /git diff --stat/);
  assert.doesNotMatch(out, /check:boundary/, "a declared command must not be listed as a problem");
});

test("#1056: says nothing when no manifest is declared, rather than warning about everything", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flow-agents-warn-none-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "no-manifest" }));
  const out = captureStderr(() => warnIfEvidenceCommandUnreconcilable(["git diff --stat"], root));
  assert.equal(out, "", "a repo that declares nothing cannot be judged; silence beats a false alarm");
});

test("#1056: is advisory — it never throws, whatever it is handed", () => {
  const root = projectWithManifest(["npm run check:boundary --"]);
  for (const commands of [[], ["git diff"], ["a", "b", "c"]]) {
    assert.doesNotThrow(() => captureStderr(() => warnIfEvidenceCommandUnreconcilable(commands, root)));
  }
  // An unreadable/nonexistent project root must fail open, not break the recording.
  assert.doesNotThrow(() =>
    captureStderr(() => warnIfEvidenceCommandUnreconcilable(["git diff"], "/definitely/not/a/repo")));
});
