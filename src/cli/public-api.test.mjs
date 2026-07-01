import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  defaultArtifactRootForRead,
  flowAgentsArtifactRoot,
  KONTOURAI_DIR,
  legacyFlowAgentsArtifactRoot,
  LEGACY_FLOW_AGENTS_DIR,
} from "../../build/src/index.js";

test("public API exports local artifact root helpers", () => {
  const cwd = path.resolve("/tmp/flow-agents-public-api");

  assert.equal(KONTOURAI_DIR, ".kontourai");
  assert.equal(LEGACY_FLOW_AGENTS_DIR, ".flow-agents");
  assert.equal(flowAgentsArtifactRoot(cwd), path.join(cwd, ".kontourai", "flow-agents"));
  assert.equal(legacyFlowAgentsArtifactRoot(cwd), path.join(cwd, ".flow-agents"));
  assert.equal(defaultArtifactRootForRead(cwd), path.join(cwd, ".kontourai", "flow-agents"));
});
