import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CLI = "build/src/cli.js";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function tree(root) {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "file",
      ...(entry.isDirectory() ? { children: tree(path.join(root, entry.name)) } : {}),
      ...(entry.isFile() ? { content: fs.readFileSync(path.join(root, entry.name), "utf8") } : {}),
    }));
}

function runKit(args) {
  return spawnSync(process.execPath, [CLI, "kit", ...args], { encoding: "utf8" });
}

const COMMANDS = [
  ["install", "usage: flow-agents kit install"],
  ["activate", "usage: flow-agents kit activate"],
  ["validate", "usage: flow-agents kit validate"],
  ["provision", "usage: flow-agents kit provision"],
  ["inspect", "usage: flow-agents kit inspect"],
  ["list", "usage: flow-agents kit list"],
  ["status", "usage: flow-agents kit status"],
];

test("kit help is subcommand-specific and does not write destinations or projections", () => {
  const dest = tempDir("kit-help-dest-");
  const target = tempDir("kit-help-target-");
  const sourceRoot = tempDir("kit-help-source-");
  fs.writeFileSync(path.join(dest, "destination-sentinel.txt"), "unchanged\n");
  fs.writeFileSync(path.join(target, "target-sentinel.txt"), "unchanged\n");
  const watched = [
    dest,
    target,
    path.join(dest, "kits", "local", "installed-kits.json"),
    path.join(dest, ".kontourai", "flow-agents", "projections"),
  ];
  const before = watched.map(tree);

  for (const [command, expectedUsage] of COMMANDS) {
    for (const help of ["--help", "-h"]) {
      const result = runKit([command, "--dest", dest, "--target", target, "--source-root", sourceRoot, help]);
      assert.equal(result.status, 0, `${command} ${help}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(expectedUsage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(result.stderr, "", `${command} ${help}: ${result.stderr}`);
    }
  }

  assert.deepEqual(watched.map(tree), before);
});

test("kit top-level help prints overall usage and is side-effect-free", () => {
  for (const help of ["--help", "-h"]) {
    const result = runKit([help]);
    assert.equal(result.status, 0, `${help}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Usage: flow-agents kit <install\|activate\|validate\|provision\|inspect\|list\|status> \[args\]/);
    assert.equal(result.stderr, "");
  }
});

test("kit install and provision still reject missing required arguments without help", () => {
  for (const command of ["install", "provision"]) {
    const result = runKit([command]);
    assert.equal(result.status, 2, `${command}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${command}: missing`));
  }
});
