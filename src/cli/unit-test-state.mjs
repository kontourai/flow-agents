import path from "node:path";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

// Node's test-file workers can inherit one real runtime actor identity. Give
// each file an owned global-state fixture before its production imports run;
// CLI children inherit it, while fixture-local explicit overrides still win.
// The test runner and CLI children must not create a new scope themselves.
if (process.argv[1] && path.basename(process.argv[1]).endsWith(".test.mjs")) {
  process.env.XDG_STATE_HOME = makeFixtureDir("flow-agents-unit-runtime-state-");
}
