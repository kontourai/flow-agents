import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { makeFixtureDir } from "./fixture-temp-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));

// The three subpaths of the assignment export and the exact value surface each one publishes.
// Pinned literally: adding or dropping an export is a deliberate, reviewed change to a contract
// that host products compile against.
const ENTRIES = {
  "./assignment-contract": [
    "ASSIGNMENT_CLAIM_RECORD_ROLE", "ASSIGNMENT_CLAIM_RECORD_SCHEMA_VERSION", "DEFAULT_TAKEOVER_GRACE_SECONDS", "TAKEOVER_RULES",
    "canonicalHolderActorKey", "computeEffectiveState", "decideTakeover", "decodeAssignmentClaimRecord",
    "findAssignmentClaimRecordProblems", "humanHeldDisposition", "isAutoSupersedable", "isHumanActor", "isTakeoverGraceElapsed",
    "parseAssignmentClaimRecord", "resolveEffectiveState", "sanitizeSegment", "serializeActor", "serializeAssignmentClaimRecord",
  ],
  "./assignment-github": [
    "GITHUB_CLAIM_COMMENT_MARKER_DEFAULT", "GITHUB_CLAIM_LABEL_DEFAULT", "extractGithubClaimRecord", "githubAssignmentStatus",
    "renderGithubClaim", "renderGithubClaimCommentBody", "renderGithubRelease", "renderGithubSupersede",
  ],
  "./assignment-local-file": [
    "assignmentFilePath", "createLocalFileAssignmentProvider", "listLocalAssignedSubjects", "performLocalClaim", "performLocalRelease",
    "performLocalReleaseUnderLock", "performLocalSupersede", "readLocalAssignmentStatus", "readLocalRecord", "withSubjectLock",
    "withSubjectLockAsync", "writeLocalRecord",
  ],
};
const PURE = ["./assignment-contract", "./assignment-github"];

test("package.json publishes the three assignment subpaths with the same shape as the existing contract subpaths", () => {
  for (const subpath of Object.keys(ENTRIES)) {
    const name = subpath.slice(2);
    assert.deepEqual(PKG.exports[subpath], { types: `./build/src/${name}.d.ts`, import: `./build/src/${name}.js` }, subpath);
    assert.deepEqual(Object.keys(PKG.exports["./console-contract"]), Object.keys(PKG.exports[subpath]), "same condition keys as ./console-contract");
    for (const target of Object.values(PKG.exports[subpath])) assert.ok(fs.existsSync(path.join(REPO, target)), `${target} must be built`);
  }
  assert.ok(PKG.files.includes("build/"), "the build output is part of the published files");
});

test("each assignment subpath exports exactly its documented value surface", async () => {
  for (const [subpath, expected] of Object.entries(ENTRIES)) {
    const mod = await import(path.join(REPO, PKG.exports[subpath].import));
    assert.deepEqual(Object.keys(mod).sort(), [...expected].sort(), subpath);
  }
});

test("a consumer outside the repo resolves every assignment subpath through the package's exports map", () => {
  const consumer = makeFixtureDir("assignment-consumer-");
  try {
    fs.mkdirSync(path.join(consumer, "node_modules", "@kontourai"), { recursive: true });
    fs.symlinkSync(REPO, path.join(consumer, "node_modules", "@kontourai", "flow-agents"), "dir");
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", type: "module" }));
    const script = `
      const out = {};
      for (const sub of ${JSON.stringify(Object.keys(ENTRIES).map((s) => s.slice(2)))}) {
        out[sub] = Object.keys(await import("@kontourai/flow-agents/" + sub)).sort();
      }
      const c = await import("@kontourai/flow-agents/assignment-contract");
      out.join = c.computeEffectiveState({ subject_id: "s", provider: "host", assignee: null, record: null }, [], undefined, 0).effective_state;
      process.stdout.write(JSON.stringify(out));
    `;
    const out = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: consumer, encoding: "utf8" }));
    for (const [subpath, expected] of Object.entries(ENTRIES)) assert.deepEqual(out[subpath.slice(2)], [...expected].sort(), subpath);
    assert.equal(out.join, "free");
    // A subpath that is not exported must still be refused: the exports map is the boundary.
    const refused = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("@kontourai/flow-agents/build/src/lib/assignment-model.js")'], { cwd: consumer, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  } finally { fs.rmSync(consumer, { recursive: true, force: true }); }
});

test("the published tarball contains every assignment subpath's JS and type declarations", () => {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const files = new Set(packed[0].files.map((f) => f.path));
  for (const subpath of Object.keys(ENTRIES)) {
    for (const target of Object.values(PKG.exports[subpath])) assert.ok(files.has(target.slice(2)), `${target} must ship in the tarball`);
  }
  for (const lib of ["assignment-model", "assignment-github", "assignment-local-store"]) {
    assert.ok(files.has(`build/src/lib/${lib}.js`), `${lib}.js is imported by an entry and must ship`);
  }
});

// ─── Purity: the pure entries import no process or filesystem capability ─────────────────────────

/** Every import specifier reachable from `entryFile` through relative imports of built JS. */
function importGraph(entryFile) {
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:^|[\s;}])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g),
      ...source.matchAll(/(?:^|[\s;}])import\s*["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
    assert.equal(/\b(createRequire|process\.binding|eval\()/.test(source), false, `${file} must not load code by an indirect route`);
    for (const spec of specifiers) {
      if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec));
      else external.add(spec);
    }
  };
  visit(entryFile);
  return { files: [...seen].map((f) => path.relative(REPO, f)).sort(), external: [...external].sort() };
}

for (const subpath of PURE) {
  test(`${subpath} is pure: its whole import graph imports no node builtin, fs, child_process, or package`, () => {
    const graph = importGraph(path.join(REPO, PKG.exports[subpath].import));
    assert.ok(graph.files.length >= 2, "the scan must actually follow the entry's relative imports");
    assert.ok(graph.files.some((f) => f.endsWith("assignment-model.js")), "the scan reached the model module");
    assert.deepEqual(graph.external, [], `${subpath} imports ${graph.external.join(", ")}`);
  });
}

test("the import-graph scan has teeth: it flags a graph that imports fs or child_process", () => {
  const dir = makeFixtureDir("assignment-purity-");
  try {
    fs.writeFileSync(path.join(dir, "leaf.js"), 'import { execFileSync } from "node:child_process";\nexport const x = execFileSync;\n');
    fs.writeFileSync(path.join(dir, "entry.js"), 'export { x } from "./leaf.js";\nimport * as fs from "fs";\nexport const y = fs;\n');
    assert.deepEqual(importGraph(path.join(dir, "entry.js")).external, ["fs", "node:child_process"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the local-file entry uses fs, path, and crypto only: no child_process, no gh", () => {
  const graph = importGraph(path.join(REPO, PKG.exports["./assignment-local-file"].import));
  assert.deepEqual(graph.external, ["node:crypto", "node:fs", "node:path"]);
});

test("the pure entries run under Node's permission model with no filesystem write and no process spawn", () => {
  const script = `
    const c = await import(${JSON.stringify(path.join(REPO, PKG.exports["./assignment-contract"].import))});
    const g = await import(${JSON.stringify(path.join(REPO, PKG.exports["./assignment-github"].import))});
    const actor = { runtime: "r", session_id: "s", host: "h", human: null };
    const state = c.computeEffectiveState({ subject_id: "x", provider: "host", assignee: null, record: null }, [], undefined, 0).effective_state;
    const rendered = g.renderGithubClaim("x", { repo: { owner: "o", name: "n" }, issue_number: 1, branch: "b", artifact_dir: "a", actor_key: c.serializeActor(actor), work_item_ref: "o/n#1" }, actor, "2026-01-01T00:00:00Z");
    let spawned = "spawned";
    try { (await import("node:child_process")).execFileSync("true"); } catch (e) { spawned = e.code; }
    process.stdout.write(JSON.stringify({ state, commands: rendered.gh_commands.length, spawned }));
  `;
  const run = spawnSync(process.execPath, ["--permission", `--allow-fs-read=${REPO}`, "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.state, "free");
  assert.equal(out.commands, 2);
  assert.equal(out.spawned, "ERR_ACCESS_DENIED", "the sandbox itself must deny spawning, or this test proves nothing");
});
