// A purge must stop a compiled brief from serving erased content (#671, store-contract Addendum M).
//
// Everything here runs at the real seams: the published Corpus store behind the kit's own adapter entry points, its
// privileged purge, the dream run that compiles and writes the brief, and the session-start reader that injects it.
// The sentinel is a unique string in one claim; each test ends by asking the reader, the way a session would, for
// the context it would receive.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as corpus from "@kontourai/corpus-store";
import { DefaultKnowledgeStore } from "../../kits/knowledge/adapters/default-store/index.js";
import { ObsidianKnowledgeStore } from "../../kits/knowledge/adapters/obsidian-store/index.js";
import { INJECTED_MEMORY_CLOSE, INJECTED_MEMORY_OPEN } from "../../kits/knowledge/memory-marker.js";
import { decodeEnvelope } from "../../kits/knowledge/dream/envelope.js";
import { PURGE_GATE_FILE, createPurgeFence, readPurgeGate, scrubBriefs } from "../../kits/knowledge/dream/purge-gate.js";
import { runDream } from "../../kits/knowledge/dream/run.js";
import { SCRIPT, hostFor, noApplyStore, runOptions, scriptedExtract, workspace } from "./dream-support.mjs";

const require = createRequire(import.meta.url);
const { profileMemoryContributor } = require("../../scripts/hooks/lib/context-contributors/profile-memory.js");
const PURGE_GATE_MODULE = pathToFileURL(path.resolve(import.meta.dirname, "../../kits/knowledge/dream/purge-gate.js")).href;
const RATIONALE = "owner asked for erasure";

/** A workspace whose dream dir is where the session-start reader looks (`$XDG_DATA_HOME/knowledge-store/knowledge/dream`). */
function readerWorkspace(t) {
  const ws = workspace({ transcripts: ["codex-rollout.jsonl"] });
  t.after(ws.cleanup);
  const xdg = path.join(ws.root, "xdg");
  const dreamDir = path.join(xdg, "knowledge-store", "knowledge", "dream");
  return { ws, xdg, dreamDir, global: path.join(dreamDir, "briefs", "global.json"), gate: path.join(dreamDir, PURGE_GATE_FILE) };
}

/** The context a session would be handed at SessionStart: the real reader, the real marker, a clean hook environment. */
function injectedContext(xdg) {
  const keys = ["XDG_DATA_HOME", "FLOW_AGENTS_HOOK_RUNTIME", "SA_HOOK_PROFILE", "SA_DISABLED_HOOKS"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { XDG_DATA_HOME: xdg, FLOW_AGENTS_HOOK_RUNTIME: "claude-code", SA_HOOK_PROFILE: "standard", SA_DISABLED_HOOKS: "" });
  try {
    return profileMemoryContributor("SessionStart", {}, 8192, { INJECTED_MEMORY_OPEN, INJECTED_MEMORY_CLOSE })?.text ?? null;
  } finally {
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  }
}

function corpusSelection(ws, { fence } = {}) {
  return {
    module: corpus,
    legacyProcessesStopped: true,
    services: { coordinationDirectory: path.join(ws.root, "coordination"), lock: corpus.standaloneFileMutationLock, coordinationIdentity: () => () => {}, allowPurge: true },
    ...(fence ? { purgeFence: fence } : {}),
  };
}

/** The kit's own adapter entry point over a real Corpus store, with purge authorized and (unless `fence` is null) fenced. */
function openStore(ws, dreamDir, { fence = createPurgeFence({ dreamDir }) } = {}) {
  fs.mkdirSync(ws.memoryRoot, { recursive: true });
  return new DefaultKnowledgeStore({ storeRoot: ws.memoryRoot, corpusStore: corpusSelection(ws, { fence: fence ?? undefined }) });
}

/** One sitting, two claims: the first carries the sentinel; the second is ordinary and must survive the purge. */
async function sentinelExtract(sentinel) {
  return scriptedExtract({
    claimsOf: (content) => {
      if (!content.includes("banker's rounding")) return [];
      const [claim] = SCRIPT[0].claims;
      return [{ ...claim, value: sentinel }, { ...claim, property: "rounding scope", value: "the total" }];
    },
  });
}

/** Seed: a dream run proposes both claims, a reviewer applies them, and a second run compiles the brief. */
async function seeded(t) {
  const env = readerWorkspace(t);
  const sentinel = `ZQ-SENTINEL-${randomUUID()}`;
  const store = openStore(env.ws, env.dreamDir);
  const host = hostFor(env.ws, noApplyStore(store), await sentinelExtract(sentinel));
  const options = (extra = {}) => runOptions(env.ws, { dreamDir: env.dreamDir, ...extra });
  assert.equal((await runDream(host, options())).status, "success");
  let sentinelRecord;
  for (const proposal of await store.listProposals()) {
    const recordId = await store.applyCreate(proposal.id, "a-human-reviewer");
    // Every proposal's body carries its sitting's whole plan, so the sentinel is in both records: tell them apart by the claim each one makes.
    if (decodeEnvelope(proposal.candidate.body).claim.value === sentinel) sentinelRecord = recordId;
  }
  assert.ok(sentinelRecord, "one applied record carries the sentinel");
  fs.rmSync(env.ws.cursorFile, { force: true });
  const report = await runDream(host, options());
  assert.equal(report.briefs_held, null);
  return { ...env, sentinel, store, host, options, sentinelRecord };
}

const purgeSentinelRecord = (seed) => seed.store.purge([seed.sentinelRecord], { agent: "owner", rationale: RATIONALE });

test("end to end: the sentinel reaches a session, a real purge erases the record, and it can no longer reach one", async (t) => {
  const seed = await seeded(t);
  const staleBrief = fs.readFileSync(seed.global, "utf8");

  // Before the purge the sentinel is in the brief file and in the context a session is handed.
  assert.ok(staleBrief.includes(seed.sentinel), "the compiled brief carries the sentinel");
  assert.ok(injectedContext(seed.xdg)?.includes(seed.sentinel), "a session is handed the sentinel");

  const result = await purgeSentinelRecord(seed);
  assert.deepEqual(result.purged, [seed.sentinelRecord]);
  assert.equal((await seed.store.get(seed.sentinelRecord)).status, "purged", "Corpus erased the record");

  // 1. Nothing is left on disk for the reader to serve, and a session is handed nothing of it.
  assert.equal(fs.existsSync(seed.global), false, "the purge removed the compiled brief");
  assert.equal(injectedContext(seed.xdg), null);

  // 2. The brief that predates the purge comes back (a backup restored, a delete that failed): the reader still refuses it.
  fs.mkdirSync(path.dirname(seed.global), { recursive: true });
  fs.writeFileSync(seed.global, staleBrief);
  const stale = injectedContext(seed.xdg);
  assert.ok(!stale?.includes(seed.sentinel), "a brief compiled before the purge is never injected");
  assert.equal(stale, null);

  // 3. The next run rebuilds from the store: the erased claim is gone, the ordinary one is back, and a session gets it.
  fs.rmSync(seed.ws.cursorFile, { force: true });
  const rebuilt = await runDream(seed.host, seed.options());
  assert.equal(rebuilt.briefs_held, null);
  assert.equal(rebuilt.brief_excluded.considered, 1, "Corpus scrubbed the erased claim's proposal, so the run no longer sees it");
  assert.equal(rebuilt.claims.created, 0, "the erased claim is not proposed again");
  const brief = JSON.parse(fs.readFileSync(seed.global, "utf8"));
  assert.ok(!JSON.stringify(brief).includes(seed.sentinel));
  assert.equal(brief.entries.length, 1);
  assert.match(brief.entries[0], /rounding scope = the total/);
  assert.equal(brief.purgeGeneration, readPurgeGate(seed.dreamDir).generation);
  const context = injectedContext(seed.xdg);
  assert.ok(context?.includes("rounding scope = the total"), "the rebuilt brief is served again");
  assert.ok(!context.includes(seed.sentinel));
});

test("a brief written before any purge keeps the plain v1 shape and is served", async (t) => {
  const seed = await seeded(t);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(seed.global, "utf8"))), ["version", "entries"]);
  assert.equal(fs.existsSync(seed.gate), false);
  assert.ok(injectedContext(seed.xdg)?.includes(seed.sentinel));
});

test("a run that read the store before the purge and writes after it leaves nothing: not on disk, not in a session", async (t) => {
  const seed = await seeded(t);
  // The purge lands between the run's store snapshot and its brief write: the brief it is about to write is stale.
  let purged = false;
  fs.rmSync(seed.ws.cursorFile, { force: true });
  const report = await runDream(seed.host, seed.options({
    onStage: async (stage) => {
      if (stage === "brief" && !purged) { purged = true; await purgeSentinelRecord(seed); }
    },
  }));
  assert.ok(purged);
  assert.equal(report.briefs_held, "purge-raced");
  assert.equal(fs.existsSync(seed.global), false, "the stale brief is not left on disk");
  assert.equal(injectedContext(seed.xdg), null);
  // The next run starts after the purge and serves a clean brief.
  fs.rmSync(seed.ws.cursorFile, { force: true });
  assert.equal((await runDream(seed.host, seed.options())).briefs_held, null);
  const context = injectedContext(seed.xdg);
  assert.ok(context && !context.includes(seed.sentinel));
});

test("a stale brief written after the gate settled is refused although it sits where the reader looks", async (t) => {
  // The hole the reader check closes on its own: whatever puts an old brief back, the stamp no longer matches.
  const seed = await seeded(t);
  const staleBrief = fs.readFileSync(seed.global, "utf8");
  await purgeSentinelRecord(seed);
  fs.mkdirSync(path.dirname(seed.global), { recursive: true });
  fs.writeFileSync(seed.global, staleBrief); // unstamped: compiled before any purge, as an older producer wrote it
  assert.ok(staleBrief.includes(seed.sentinel));
  assert.equal(injectedContext(seed.xdg), null);
  fs.writeFileSync(seed.global, JSON.stringify({ ...JSON.parse(staleBrief), purgeGeneration: "0".repeat(32) })); // stamped, but not with this gate's token
  assert.equal(injectedContext(seed.xdg), null);
});

test("a purge that dies after opening the gate refuses every brief until a purge runs again; the run holds back instead of writing", async (t) => {
  const seed = await seeded(t);
  const staleBrief = fs.readFileSync(seed.global, "utf8");
  assert.ok(injectedContext(seed.xdg)?.includes(seed.sentinel));
  // A real process death: the child opens the fence and kills itself inside the purge.
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createPurgeFence } from ${JSON.stringify(PURGE_GATE_MODULE)};
    await createPurgeFence({ dreamDir: ${JSON.stringify(seed.dreamDir)} })(async () => { process.kill(process.pid, "SIGKILL"); });
  `], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", `the child died inside the purge: ${child.stderr}`);
  assert.equal(readPurgeGate(seed.dreamDir).state, "purging");

  // The brief file is still there with its sentinel; the reader refuses it, and so would a dream run's write.
  assert.ok(fs.readFileSync(seed.global, "utf8").includes(seed.sentinel));
  assert.equal(injectedContext(seed.xdg), null);
  // Even a brief stamped with the open gate's own token is refused: an open purge means the store is changing.
  fs.writeFileSync(seed.global, JSON.stringify({ version: 1, entries: ["[stated · unreviewed] anything"], purgeGeneration: readPurgeGate(seed.dreamDir).generation }));
  assert.equal(injectedContext(seed.xdg), null);
  fs.writeFileSync(seed.global, staleBrief);
  fs.rmSync(seed.ws.cursorFile, { force: true });
  const held = await runDream(seed.host, seed.options());
  assert.equal(held.briefs_held, "purge-in-progress");
  assert.equal(held.briefs.length, 0);

  // Running the purge again opens and settles the gate (the dead owner's lock is not a block).
  await purgeSentinelRecord(seed);
  assert.equal(readPurgeGate(seed.dreamDir).state, "settled");
  fs.rmSync(seed.ws.cursorFile, { force: true });
  assert.equal((await runDream(seed.host, seed.options())).briefs_held, null);
  const context = injectedContext(seed.xdg);
  assert.ok(context && !context.includes(seed.sentinel));
});

test("if the gate cannot be opened the purge does not run", async (t) => {
  const env = readerWorkspace(t);
  const blocker = path.join(env.ws.root, "not-a-directory");
  fs.writeFileSync(blocker, "x");
  const store = openStore(env.ws, path.join(blocker, "dream")); // the gate's directory cannot be created
  const id = await store.create({ type: "raw", title: "Kept", body: "still here", category: "test", provenance: { agent: "test" } });
  await assert.rejects(() => store.purge([id], { agent: "owner", rationale: RATIONALE }));
  assert.equal((await store.get(id)).body, "still here", "an unfenced purge is not possible through the fenced store");
});

test("a failed purge still settles the gate: the old briefs are refused and the next run rebuilds", async (t) => {
  const seed = await seeded(t);
  await assert.rejects(() => seed.store.purge(["no-such-record"], { agent: "owner", rationale: RATIONALE }));
  assert.equal(readPurgeGate(seed.dreamDir).state, "settled");
  assert.equal(fs.existsSync(seed.global), false);
});

test("two purges at once: the second is refused while the first holds the gate", async (t) => {
  const env = readerWorkspace(t);
  const fence = createPurgeFence({ dreamDir: env.dreamDir });
  let releaseFirst;
  const first = fence(() => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => fence(async () => "second"), (error) => error.code === "PURGE_GATE_BUSY");
  assert.equal(readPurgeGate(env.dreamDir).state, "purging");
  releaseFirst("first");
  assert.equal(await first, "first");
  assert.equal(readPurgeGate(env.dreamDir).state, "settled");
  assert.equal(await fence(async () => "third"), "third");
});

test("settling the gate issues a new token: a brief stamped with the opening token is not served afterwards", async (t) => {
  const env = readerWorkspace(t);
  let opening;
  await createPurgeFence({ dreamDir: env.dreamDir })(async () => { opening = readPurgeGate(env.dreamDir); });
  assert.equal(opening.state, "purging");
  const settled = readPurgeGate(env.dreamDir);
  assert.equal(settled.state, "settled");
  assert.notEqual(settled.generation, opening.generation);
  fs.mkdirSync(path.dirname(env.global), { recursive: true });
  fs.writeFileSync(env.global, JSON.stringify({ version: 1, entries: ["[stated · unreviewed] written while the purge was open"], purgeGeneration: opening.generation }));
  assert.equal(injectedContext(env.xdg), null);
  fs.writeFileSync(env.global, JSON.stringify({ version: 1, entries: ["[stated · unreviewed] written after it settled"], purgeGeneration: settled.generation }));
  assert.match(injectedContext(env.xdg), /written after it settled/);
});

test("the reader's gate rules: only a settled gate with a matching stamp, or no gate and no stamp, serves a brief", async (t) => {
  const env = readerWorkspace(t);
  const token = "a".repeat(32);
  const entry = "[stated · unreviewed] gate rules";
  const brief = (stamp) => JSON.stringify({ version: 1, entries: [entry], ...(stamp === undefined ? {} : { purgeGeneration: stamp }) });
  const gateJson = (fields) => JSON.stringify({ version: 1, generation: token, state: "settled", ...fields });
  const outside = path.join(env.ws.root, "outside-gate.json");
  fs.writeFileSync(outside, gateJson({}));
  const cases = [
    ["no gate, no stamp", null, undefined, true],
    ["no gate, but a stamp (the gate was deleted)", null, token, false],
    ["settled gate, matching stamp", gateJson({}), token, true],
    ["settled gate, no stamp", gateJson({}), undefined, false],
    ["settled gate, other stamp", gateJson({}), "b".repeat(32), false],
    ["settled gate, stamp of another type", gateJson({}), 7, false],
    ["purging gate, matching stamp", gateJson({ state: "purging" }), token, false],
    ["unknown state", gateJson({ state: "open" }), token, false],
    ["unknown gate version", gateJson({ version: 2 }), token, false],
    ["generation that is not 32 hex digits", gateJson({ generation: "short" }), "short", false],
    ["gate that is not JSON", "{", token, false],
    ["gate that is JSON null", "null", token, false],
    ["gate over 1024 bytes", gateJson({ padding: "x".repeat(1100) }), token, false],
    ["gate that is a symlink to a valid gate", { link: outside }, token, false],
    ["gate that is a directory", { directory: true }, token, false],
  ];
  fs.mkdirSync(path.dirname(env.global), { recursive: true });
  for (const [label, gate, stamp, served] of cases) {
    fs.rmSync(env.gate, { recursive: true, force: true });
    if (typeof gate === "string") fs.writeFileSync(env.gate, gate);
    else if (gate?.link) fs.symlinkSync(gate.link, env.gate);
    else if (gate?.directory) fs.mkdirSync(env.gate);
    fs.writeFileSync(env.global, brief(stamp));
    const context = injectedContext(env.xdg);
    if (served) assert.ok(context?.includes(entry), label);
    else assert.equal(context, null, label);
  }
});

test("a brief file that cannot be deleted is reported, does not fail the purge, and is still not served", async (t) => {
  const env = readerWorkspace(t);
  fs.mkdirSync(path.join(env.dreamDir, "briefs", "global.json"), { recursive: true }); // a directory where the file should be
  const heard = [];
  const result = await createPurgeFence({ dreamDir: env.dreamDir, onScrub: (report) => heard.push(report) })(async () => "purged");
  assert.equal(result, "purged");
  assert.equal(heard.length, 1);
  assert.deepEqual(heard[0].removed, []);
  assert.equal(heard[0].failed[0].name, "global.json");
  assert.equal(scrubBriefs(path.join(env.ws.root, "elsewhere")).failed.length, 0, "no briefs directory is not a failure");
  assert.equal(injectedContext(env.xdg), null);
});

for (const [name, Adapter] of [["default", DefaultKnowledgeStore], ["vault", ObsidianKnowledgeStore]]) {
  test(`${name}: the adapter entry point fences purge, and a read-only preview is not fenced`, async (t) => {
    const env = readerWorkspace(t);
    const events = [];
    const fence = async (run) => { events.push("open"); try { return await run(); } finally { events.push("settle"); } };
    const store = new Adapter({ storeRoot: path.join(env.ws.root, "store"), corpusStore: corpusSelection(env.ws, { fence }) });
    const id = await store.create({ type: "raw", title: "Erased", body: "secret", category: "test", provenance: { agent: "test" } });
    await store.get(id);
    assert.deepEqual(events, [], "ordinary operations are not fenced");
    await store.purge([id], { agent: "owner", rationale: RATIONALE });
    assert.deepEqual(events, ["open", "settle"]);
    assert.equal((await store.get(id)).status, "purged");
    assert.throws(() => new Adapter({ storeRoot: path.join(env.ws.root, "bad"), corpusStore: corpusSelection(env.ws, { fence: "not a function" }) }), /purgeFence must be a function/);
  });
}
