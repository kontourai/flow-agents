import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { walkFiles as toolsWalkFiles } from "../../build/src/tools/common.js";
import { walkFiles as libWalkFiles } from "../../build/src/lib/fs.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

// Regression guard for #1006: `out.push(...walkFiles(child))` passes one *argument* per
// discovered path, so a subtree larger than the engine's argument limit throws
// `RangeError: Maximum call stack size exceeded` — regardless of recursion depth.
// This broke `validate:source`, a pre-push gate, in checkouts with a large untracked
// directory (measured: 250,709 files, 69% of them under an in-repo worktrees dir).
//
// FILE_COUNT must exceed that argument limit or the test proves nothing: the failure is
// completely invisible below the threshold. Measured on this repo's Node (v24.18.0, the
// version pinned in .tool-versions) by binary search on `[].push(...new Array(n))`:
//
//   top-level spread    last OK 123,923 / first RangeError 123,924
//   inside 1 stack frame  last OK 123,895   (walkFiles spreads at depth >= 1)
//   inside 10 stack frames last OK 123,769
//
// The limit is V8's argument-count cap, so it barely moves with recursion depth but does
// shift with the engine build and remaining stack. 130,000 sits ~5% above the measured
// ceiling — enough headroom to reproduce reliably rather than marginally, while keeping
// the tree small enough to build and delete in roughly ten seconds. Do not lower it
// toward ~124,000 to save time: that trades the whole point of the test for a few seconds.
const FILE_COUNT = 130_000;

test("walkFiles returns subtrees larger than the engine argument limit without overflowing", (t) => {
  // Built outside the repo so the tree can never be picked up by a repo-wide scan.
  const root = makeFixtureDir("flow-agents-walk-scale-");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // One nested directory holds every file, so the parent frame spreads the full result.
  const nested = path.join(root, "nested");
  fs.mkdirSync(nested);
  for (let index = 0; index < FILE_COUNT; index += 1) {
    fs.closeSync(fs.openSync(path.join(nested, `f${index}`), "w"));
  }

  const fromTools = toolsWalkFiles(root);
  assert.equal(fromTools.length, FILE_COUNT);
  assert.ok(fromTools.every((file) => file.startsWith(nested + path.sep)));

  const fromLib = libWalkFiles(root);
  assert.equal(fromLib.length, FILE_COUNT);
});
