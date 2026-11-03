// Shared support for the dream tests: a Corpus-shaped create-proposal store, fixture builders in the exact
// shapes the real producers write, and a scripted model bound through the real Traverse extract().
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeModelRuntime } from "@kontourai/relay";
import { bindTraverseExtract } from "../../kits/knowledge/dream/model.js";

export const RUNTIME_FIXTURES = path.resolve(import.meta.dirname, "..", "..", "kits", "knowledge", "promote", "fixtures", "runtime");
// Assembled from fragments, as the #669 suite does, so no detector-shaped literal is committed.
export const CANARIES = {
  __CANARY_GITHUB__: ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join(""),
  __CANARY_OPENAI__: ["sk", "-proj-", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2"].join(""),
  __CANARY_AWS__: ["AK", "IA", "Q7FIXTURE0EXAMPL"].join(""),
  __CANARY_ASSIGN__: ["fixture", "Secret", "Value123"].join(""),
  __CANARY_TOOL_RESULT__: ["toolresult", "Canary987"].join(""),
};
export const NOW_MS = Date.parse("2026-11-02T00:00:00Z");
export const NOW_ISO = "2026-11-02T00:00:00.000Z";

export function tempDir(prefix = "dream-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix)));
}

/** Copy the #669 transcript fixtures into `root`, with canary placeholders assembled. */
export function stageTranscripts(root, names = ["codex-rollout.jsonl", "claude-project.jsonl"]) {
  const out = {};
  fs.mkdirSync(root, { recursive: true });
  for (const name of names) {
    let text = fs.readFileSync(path.join(RUNTIME_FIXTURES, name), "utf8");
    for (const [placeholder, value] of Object.entries(CANARIES)) text = text.replaceAll(placeholder, value);
    out[name] = path.join(root, name);
    fs.writeFileSync(out[name], text);
  }
  return out;
}

/** One canonical 0.3.0 telemetry line, as the full channel writes it. */
export function telemetryLine(runtime, transcriptPath, extra = {}) {
  return `${JSON.stringify({
    schema_version: "0.3.0",
    timestamp: "1793455200000",
    session_id: "telemetry-session",
    event_id: randomUUID(),
    event_type: "stop",
    agent: { name: "dev", runtime, version: "fixture" },
    install_identity: { package_version: "fixture", content_fingerprint: "fixture", source: "fixture" },
    hook: { event_name: "Stop", runtime_session_id: "runtime-session", turn_id: "", transcript_path: transcriptPath, model: "", source: "", stop_hook_active: false, last_assistant_message: "", raw_input: null },
    ...extra,
  })}\n`;
}

/** A workspace: telemetry file, transcript root, dream dir and memory root. */
export function workspace({ transcripts = ["codex-rollout.jsonl", "claude-project.jsonl"] } = {}) {
  const root = tempDir("dream-ws-");
  const transcriptRoot = path.join(root, "transcripts");
  const staged = stageTranscripts(transcriptRoot, transcripts);
  const telemetryFile = path.join(root, "telemetry.jsonl");
  fs.writeFileSync(telemetryFile, transcripts.map((name) => telemetryLine(name.startsWith("codex") ? "codex" : "claude-code", staged[name])).join(""));
  return {
    root, transcriptRoot, telemetryFile,
    dreamDir: path.join(root, "dream"),
    memoryRoot: path.join(root, "memory"),
    briefs: (name = "global.json") => path.join(root, "dream", "briefs", name),
    cursorFile: path.join(root, "dream", "cursors", "runtime-session.cursor.json"),
    reports: () => {
      const dir = path.join(root, "dream", "reports");
      return fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))) : [];
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

// ── A Corpus-shaped create-proposal store ─────────────────────────────────────────────────────────────
// Same proposal shape and rules as kontourai/corpus#42 (KitCreateProposal): pending/applied/rejected, a record
// only on applyCreate, SELF_APPROVAL when the reviewer is the proposer. The verbs are the corpus#40 amendment's
// `applyCreate` / `rejectCreate`; the guard below also blocks the earlier overloaded `apply` / `reject`. Proposals persist as files, so a second "process"
// over the same root sees the first one's.

export class FakeCorpusStore {
  constructor(root, { clock = () => new Date().toISOString() } = {}) {
    this.root = root;
    this.dir = path.join(root, ".corpus-proposals");
    this.clock = clock;
    this.records = new Map();
    this.calls = { proposeCreate: 0, applyCreate: 0, rejectCreate: 0, listProposals: 0 };
    this.failures = [];
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Fail the nth (0-based, counting every call) proposeCreate. `after: true` stores the proposal first, then throws. */
  failProposeCreate(n, { after = false } = {}) {
    this.failures.push({ n, after });
  }

  #file(id) { return path.join(this.dir, `${id}.json`); }
  #write(proposal) { fs.writeFileSync(this.#file(proposal.id), JSON.stringify(proposal, null, 2)); }

  async proposeCreate(candidate, proposerId, evidence) {
    const call = this.calls.proposeCreate++;
    const failure = this.failures.find((entry) => entry.n === call);
    if (failure && !failure.after) throw Object.assign(new Error("injected proposeCreate failure"), { code: "INJECTED" });
    for (const field of ["title", "body", "category"]) {
      if (typeof candidate?.[field] !== "string" || !candidate[field].trim()) throw Object.assign(new Error(`missing required field: ${field}`), { code: "MISSING_EVIDENCE" });
    }
    if (!proposerId || !evidence?.agent || !evidence?.proposal) throw Object.assign(new Error("missing evidence"), { code: "MISSING_EVIDENCE" });
    const id = `prop-${String(fs.readdirSync(this.dir).length + 1).padStart(4, "0")}`;
    this.#write({ id, state: "pending", candidate: JSON.parse(JSON.stringify(candidate)), proposer_id: proposerId, evidence: { agent: evidence.agent, proposal: evidence.proposal }, proposed_at: this.clock() });
    if (failure?.after) throw Object.assign(new Error("injected failure after the proposal was stored"), { code: "INJECTED" });
    return id;
  }

  async getProposal(id) {
    try { return JSON.parse(fs.readFileSync(this.#file(id), "utf8")); } catch { return null; }
  }

  async listProposals({ state } = {}) {
    this.calls.listProposals += 1;
    const wanted = state === undefined ? null : [state].flat();
    return fs.readdirSync(this.dir).filter((name) => name.endsWith(".json")).sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")))
      .filter((proposal) => !wanted || wanted.includes(proposal.state))
      .sort((a, b) => a.proposed_at.localeCompare(b.proposed_at) || a.id.localeCompare(b.id));
  }

  async applyCreate(proposalId, reviewerId) {
    this.calls.applyCreate += 1;
    const proposal = await this.getProposal(proposalId);
    if (!proposal) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
    if (proposal.state !== "pending") throw Object.assign(new Error("not pending"), { code: "MISSING_EVIDENCE" });
    if (proposal.proposer_id === reviewerId) throw Object.assign(new Error("SELF_APPROVAL"), { code: "SELF_APPROVAL" });
    const recordId = `rec-${proposalId}`;
    this.records.set(recordId, { id: recordId, type: "raw", ...proposal.candidate, created_at: this.clock(), updated_at: this.clock() });
    this.#write({ ...proposal, state: "applied", reviewer_id: reviewerId, decided_at: this.clock(), record_id: recordId });
    return recordId;
  }

  async rejectCreate(proposalId, reviewerId, rationale) {
    this.calls.rejectCreate += 1;
    const proposal = await this.getProposal(proposalId);
    this.#write({ ...proposal, state: "rejected", reviewer_id: reviewerId, decided_at: this.clock(), rationale });
  }

  async get(recordId) { return this.records.get(recordId) ?? null; }
  retire(recordId) { this.records.set(recordId, { ...this.records.get(recordId), status: "retired" }); }
}

const SETTLING_VERBS = new Set(["apply", "reject", "applyCreate", "rejectCreate"]);

/** A store whose settling verbs throw: any call from the run fails the test where it happens. */
export function noApplyStore(store) {
  return new Proxy(store, {
    get(target, prop) {
      if (SETTLING_VERBS.has(prop)) return () => { throw new Error(`the dream run called store.${String(prop)}`); };
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// ── A scripted model ───────────────────────────────────────────────────────────────────────────────────────

/** The claims a scripted model "finds", keyed by a distinctive phrase in the sitting content. */
export const SCRIPT = [
  { when: "banker's rounding", claims: [{ quote: "I switched to banker's rounding on the total.", subject: "ledger service", subjectType: "service", property: "rounding mode", value: "banker's rounding", posture: "stated" }] },
  { when: "document the rounding rule", claims: [{ quote: "Documented in docs/rounding.md.", subject: "ledger service", subjectType: "service", property: "rounding docs", value: "docs/rounding.md", posture: "stated" }] },
  { when: "retry budget in the widget service", claims: [{ quote: "The reset fires on every 429.", subject: "widget service", subjectType: "service", property: "retry budget reset trigger", value: "every 429", posture: "stated" }] },
  { when: "regression test for the reset", claims: [{ quote: "Added a test that fails if the budget resets on a 429.", subject: "widget service", subjectType: "service", property: "retry budget regression test", value: "present", posture: "stated" }] },
];

function providerFor(claimsOf, calls) {
  return {
    name: "scripted-replay",
    async extract(input) {
      calls.push(input);
      const claims = claimsOf(input.content, calls.length - 1);
      const proposals = [];
      claims.forEach((claim, index) => {
        for (const field of ["subject", "subjectType", "property", "value", "speaker", "posture", "validFrom", "validUntil", "replacesPrior"]) {
          if (claim[field] === undefined) continue;
          proposals.push({ fieldPath: `claims[${index}].${field}`, candidateValue: claim[field], confidence: 0.9, provenance: { excerpt: claim.quote, locator: "" }, extractor: "scripted-replay" });
        }
      });
      return { proposals, raw: { response: "scripted", model: "scripted-replay" } };
    },
  };
}

/** `extract` for the run: Traverse's real extract() over a scripted provider. `calls` records every request. */
export async function scriptedExtract({ script = SCRIPT, claimsOf, fail } = {}) {
  const calls = [];
  const find = claimsOf ?? ((content) => script.filter((entry) => content.includes(entry.when)).flatMap((entry) => entry.claims));
  const provider = providerFor((content, n) => { if (fail?.(n)) throw new Error("scripted model outage"); return find(content, n); }, calls);
  const extract = await bindTraverseExtract(provider);
  return Object.assign(extract, { calls });
}

/** A Relay FakeModelRuntime that answers an extraction tool call with the given claims. */
export function fakeRelayClaims(claims, { id = "fake-runtime" } = {}) {
  const proposals = [];
  claims.forEach((claim, index) => {
    for (const field of ["subject", "subjectType", "property", "value", "posture"]) {
      proposals.push({ fieldPath: `claims[${index}].${field}`, value: claim[field], confidence: 0.9, excerpt: claim.quote });
    }
  });
  const result = () => ({
    provider: "fake", model: "fake-model", modelSource: "configured", outputText: "",
    toolCalls: [{ id: "call-1", name: "submit_extraction_proposals", input: { proposals } }],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0 }, latencyMs: 1, stopReason: "tool_use",
  });
  return new FakeModelRuntime(Array.from({ length: 16 }, result), id);
}

export function hostFor(ws, store, extract, extra = {}) {
  const registered = [];
  return {
    store, extract,
    root: ws.memoryRoot, rootName: "memory",
    registerRoot: (name, root) => { registered.push([name, root]); },
    registered,
    ...extra,
  };
}

// A clock that moves one second per reading, shared by every run, so run ids and report names sort in run order.
let ticks = 0;
export const tickingNow = () => new Date(NOW_MS + 1000 * ticks++).toISOString();

/** What the host says these sittings may be shown to. A run without it makes sealed claims, which no brief carries. */
export const VISIBILITY = { kind: "restricted", audiences: ["user:owner"] };

export const runOptions = (ws, extra = {}) => ({
  enabled: true, visibility: VISIBILITY, telemetryFile: ws.telemetryFile, transcriptRoots: [ws.transcriptRoot], dreamDir: ws.dreamDir, nowMs: NOW_MS, now: tickingNow, ...extra,
});

export function listFilesDeep(root) {
  const out = {};
  if (!fs.existsSync(root)) return out;
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}
