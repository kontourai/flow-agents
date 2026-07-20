import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

test("kit install identifies a missing root kit manifest as a repository-shape error", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "kit-missing-manifest-source-"));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "kit-missing-manifest-dest-"));
  const result = spawnSync(process.execPath, ["build/src/cli.js", "kit", "install", source, "--dest", dest], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /missing required root Flow Kit manifest \(kit\.json\)/);
  assert.doesNotMatch(result.stdout, /invalid JSON/);
});
