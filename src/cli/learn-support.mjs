// Shared support for the correction-recurrence learn tests. Every transcript here is synthetic: it is written in
// the exact line shape Claude Code writes (the same shape as kits/knowledge/promote/fixtures/runtime/claude-project.jsonl),
// with invented sessions, paths and text. No real transcript is used anywhere.
import fs from "node:fs";
import path from "node:path";
import { readRuntimeMessages } from "../../kits/knowledge/promote/runtime-transcript.js";
import { makeFixtureDir } from "./fixture-temp-dir.mjs";

export const NOW_MS = Date.parse("2026-11-12T00:00:00Z");
export const DAY_MS = 86_400_000;
export const CWD = "/Users/fixture-user/dev/widget-service";

// Assembled from fragments so no detector-shaped literal is committed (the #669 suite's convention).
export const CANARIES = {
  github: ["gh", "p_", "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8"].join(""),
  openai: ["sk", "-proj-", "Mm9Nn8Bb7Vv6Cc5Xx4Zz3Ll2"].join(""),
  assign: ["fixture", "Secret", "Value456"].join(""),
};

/** The rules the fake model generalizes each fixture theme to. */
export const THEME_RULES = {
  "fetch-main": "Fetch latest main before starting any work",
  "act-on-recommendation": "Act on your own recommendation instead of stopping to ask",
  "batch-prs": "Batch related changes into the fewest pull requests",
  "pin-sha": "Pin commit SHAs in permalinks instead of branch names",
};

const uuidFor = (session, n) => `${session.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * One Claude Code session file. `turns`: `{ role, text, origin?, promptSource?, isSidechain?, isCompactSummary? }`.
 * A plain `{ text }` is a person typing in the composer (`promptSource: "typed"`, `origin.kind: "human"`); `bare: true`
 * writes the record with no origin signal.
 */
export function claudeSession(sessionId, startMs, turns) {
  const lines = [];
  let parent = null;
  turns.forEach((turn, n) => {
    const uuid = uuidFor(sessionId, n + 1);
    const timestamp = new Date(startMs + n * 60_000).toISOString();
    const common = { parentUuid: parent, isSidechain: turn.isSidechain === true, uuid, timestamp, cwd: CWD, sessionId, version: "2.1.316", gitBranch: "main", userType: "external", entrypoint: "cli" };
    if (turn.role === "assistant") {
      lines.push({ ...common, message: { model: "claude-opus-5-5", id: `msg_${n}`, type: "message", role: "assistant", content: [{ type: "text", text: turn.text }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }, requestId: `req_${n}`, type: "assistant" });
    } else {
      // `bare: true` is a record with no origin signal at all (as the harness writes an injected reminder).
      const human = !turn.bare && turn.origin === undefined && turn.promptSource === undefined && !turn.isSidechain && !turn.isCompactSummary;
      const promptSource = human ? "typed" : turn.promptSource;
      const origin = human ? { kind: "human" } : turn.origin;
      lines.push({
        ...common, promptId: `p-${timestamp}`, message: { role: "user", content: turn.text }, permissionMode: "default", type: "user",
        ...(promptSource ? { promptSource } : {}), ...(origin ? { origin } : {}), ...(turn.isCompactSummary ? { isCompactSummary: true } : {}),
      });
    }
    parent = uuid;
  });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export const sessionId = (n) => `${String(n).padStart(8, "a")}-1111-4000-8000-${String(n).padStart(12, "0")}`;

/** A transcript root with one file per session, under a Claude-projects-like layout. */
export function transcriptRoot(sessions) {
  const root = makeFixtureDir("learn-transcripts-");
  const dir = path.join(root, "-Users-fixture-user-dev-widget-service");
  fs.mkdirSync(dir, { recursive: true });
  for (const { id, startMs, turns } of sessions) fs.writeFileSync(path.join(dir, `${id}.jsonl`), claudeSession(id, startMs, turns));
  return root;
}

export function workspace() {
  const root = makeFixtureDir("learn-ws-");
  return { root, ledger: path.join(root, ".kontourai", "telemetry", "learning-review-proposals.jsonl"), reviewItems: path.join(root, ".kontourai", "telemetry", "correction-recurrence.review-items.json") };
}

/** Does the installed Ferry derive `origin` on user messages (>= 0.8.0)? */
export function ferryDerivesOrigin() {
  const probe = claudeSession(sessionId(999), NOW_MS - DAY_MS, [{ text: "probe" }]);
  return readRuntimeMessages("claude-code", Buffer.from(probe)).messages.some((message) => message.origin !== undefined);
}

/**
 * STAND-IN for Ferry >= 0.8.0's Claude Code origin derivation, used only when the installed Ferry derives none, so the
 * pipeline below the importer can be tested on either version. It covers the subset of signals these fixtures use
 * (Ferry's `claudeUserOrigin`); the real derivation is exercised whenever the installed Ferry has it (see
 * `ferryDerivesOrigin` and the "real Ferry" test).
 */
export function readMessagesWithFixtureOrigin(harness, content) {
  const parsed = readRuntimeMessages(harness, content);
  if (parsed.messages.some((message) => message.origin !== undefined)) return parsed;
  const events = new Map(content.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).map((event) => [event.uuid, event]));
  const MAP = { human: "human", "task-notification": "task-notification", peer: "agent", coordinator: "agent", "auto-continuation": "harness" };
  const originOf = (event) => {
    const text = typeof event.message?.content === "string" ? event.message.content : "";
    if (event.isCompactSummary === true) return { kind: "compaction" };
    const source = event.promptSource;
    if (source === "suggestion_accepted") return { kind: "unknown" };
    const mapped = MAP[event.origin?.kind];
    const trusted = source === undefined || source === "typed" || source === "queued";
    if (mapped && (mapped !== "human" || trusted)) return { kind: mapped };
    if (/^\s*<system-reminder>[\s\S]*<\/system-reminder>\s*$/.test(text)) return { kind: "harness" };
    if (source === "typed" || source === "queued") return { kind: "human" };
    if (event.isSidechain === true) return { kind: "agent" };
    return { kind: "unknown" };
  };
  return { ...parsed, messages: parsed.messages.map((message) => (message.role === "user" ? { ...message, origin: originOf(events.get(message.id) ?? {}) } : message)) };
}

/** The reader the tests use: the real importer when it derives origin, else the stand-in above. */
export const testReader = () => (ferryDerivesOrigin() ? undefined : readMessagesWithFixtureOrigin);

/** A correction a person typed, tagged so the fake model can classify it. */
export const fix = (theme, pain = 1, kind = "correction", words = "please do this differently next time") => `${words} [fix:${theme}:${kind}:${pain}]`;

/**
 * A recording Relay ModelRuntime. It answers each forced tool call deterministically from the fixture tags, and keeps
 * every request it was sent (the privacy proof reads them).
 *  - classify: `[fix:<theme>:<kind>:<pain>]` -> that kind/pain and THEME_RULES[theme]; `[oneoff:<theme>]` -> general false; else none
 *  - cluster: a rule equal to an existing theme label joins it; otherwise one new theme per distinct rule
 *  - judge: `judgements[rule] = { relation, needle }` -> the first line containing needle
 */
export function recordingRuntime({ judgements = {}, failOn = null } = {}) {
  const requests = [];
  const result = (name, input, stopReason = "tool_use") => ({ provider: "fake", model: "fake-model", modelSource: "configured", outputText: "", toolCalls: name ? [{ id: `call-${requests.length}`, name, input }] : [], usage: { totalTokens: 1 }, latencyMs: 1, stopReason });
  return {
    id: "recording-runtime",
    requests,
    capabilities: () => ({ structuredTools: true, streaming: false, abort: false, usage: true }),
    async invoke(request) {
      requests.push(structuredClone(request));
      const tool = request.tools[0].name;
      const prompt = request.messages[0].content;
      if (failOn === tool) return result(null, null);
      if (tool === "record_turn_classifications") {
        const items = [...prompt.matchAll(/<message i="(\d+)">([\s\S]*?)<\/message>/g)].map(([, i, body]) => {
          const tag = /\[fix:([a-z-]+):([a-z]+):(\d)\]/.exec(body);
          const oneoff = /\[oneoff:([a-z-]+)\]/.exec(body);
          if (tag) return { i: Number(i), kind: tag[2], pain: Number(tag[3]), rule: THEME_RULES[tag[1]], general: true };
          if (oneoff) return { i: Number(i), kind: "correction", pain: 1, rule: THEME_RULES[oneoff[1]], general: false };
          return { i: Number(i), kind: "none", pain: 0, rule: "", general: false };
        });
        return result(tool, { items });
      }
      if (tool === "assign_rule_themes") {
        const existing = new Map([...prompt.matchAll(/^- ([a-z0-9-]+): (.+)$/gm)].map(([, id, label]) => [label, id]));
        const rules = [...prompt.matchAll(/^(\d+)\. (.+)$/gm)].map(([, i, rule]) => ({ i: Number(i), rule }));
        const created = new Map();
        const assignments = rules.map(({ i, rule }) => {
          if (existing.has(rule)) return { i, theme: existing.get(rule) };
          if (!created.has(rule)) created.set(rule, `new${created.size}`);
          return { i, theme: created.get(rule) };
        });
        return result(tool, { new_themes: [...created].map(([label, key]) => ({ key, label })), assignments });
      }
      if (tool === "judge_rule_against_file") {
        const rule = /PROPOSED RULE: (.+)/.exec(prompt)[1];
        const wanted = judgements[rule];
        if (!wanted) return result(tool, { relation: "none", line: null, explanation: "unrelated" });
        const line = [...prompt.matchAll(/^(\d+): (.*)$/gm)].find(([, , text]) => text.includes(wanted.needle));
        return result(tool, { relation: wanted.relation, line: wanted.line ?? (line ? Number(line[1]) : 9999), explanation: `${wanted.relation} by fixture` });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

/** `n` sessions, each with the given human turns between assistant replies, one day apart, ending before NOW_MS. */
export function sessionsWith(perSession, { firstDay = 20, idOffset = 0 } = {}) {
  return perSession.map((texts, n) => ({
    id: sessionId(idOffset + n + 1),
    startMs: NOW_MS - (firstDay - n) * DAY_MS,
    turns: texts.flatMap((text) => (typeof text === "string" ? [{ role: "assistant", text: "Here is what I did." }, { text }] : [{ role: "assistant", text: "Here is what I did." }, text])),
  }));
}
