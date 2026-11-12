// Shared support for the correction-recurrence learn tests. Every transcript here is synthetic: it is written in
// the exact line shape Claude Code writes (the same shape as kits/knowledge/promote/fixtures/runtime/claude-project.jsonl),
// with invented sessions, paths and text. No real transcript is used anywhere.
import fs from "node:fs";
import path from "node:path";
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
  "fetch-rebase": "Fetch and rebase on main before starting work",
};

const uuidFor = (session, n) => `${session.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * One Claude Code session file. `turns`: `{ role, text, origin?, promptSource?, isSidechain?, isCompactSummary? }`.
 * A plain `{ text }` is a person typing in the composer (`promptSource: "typed"`, `origin.kind: "human"`); `bare: true`
 * writes the record with no origin signal.
 */
export function claudeSession(sessionId, startMs, turns, { cwd = CWD } = {}) {
  const lines = [];
  let parent = null;
  turns.forEach((turn, n) => {
    const uuid = uuidFor(sessionId, n + 1);
    const timestamp = new Date(startMs + n * 60_000).toISOString();
    const common = { parentUuid: parent, isSidechain: turn.isSidechain === true, uuid, timestamp, cwd, sessionId, version: "2.1.316", gitBranch: "main", userType: "external", entrypoint: "cli" };
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
  for (const { id, startMs, turns, cwd } of sessions) fs.writeFileSync(path.join(dir, `${id}.jsonl`), claudeSession(id, startMs, turns, { cwd }));
  return root;
}

export function workspace() {
  const root = makeFixtureDir("learn-ws-");
  return { root, ledger: path.join(root, ".kontourai", "telemetry", "learning-review-proposals.jsonl"), reviewItems: path.join(root, ".kontourai", "telemetry", "correction-recurrence.review-items.json") };
}

/** A correction a person typed, tagged so the fake model can classify it. */
export const fix = (theme, pain = 1, kind = "correction", words = "please do this differently next time") => `${words} [fix:${theme}:${kind}:${pain}]`;

/**
 * The JSON that follows `marker` in a prompt. The learn prompts put each block's JSON on the next line: either a
 * one-line array, or `[`, one item per line, `]`.
 */
export function promptJson(prompt, marker) {
  const at = prompt.indexOf(`${marker}\n`);
  if (at === -1) return null;
  const rest = prompt.slice(at + marker.length + 1);
  const block = rest.startsWith("[\n") ? rest.slice(0, rest.indexOf("\n]") + 2) : rest.split("\n")[0];
  return JSON.parse(block);
}

/**
 * A recording Relay ModelRuntime. It answers each forced tool call deterministically from the fixture tags, and keeps
 * every request it was sent (the privacy proof reads them).
 *  - classify: `[fix:<theme>:<kind>:<pain>]` -> that kind/pain and THEME_RULES[theme]; `[oneoff:<theme>]` -> general false; else none
 *  - cluster: a rule equal to an existing theme label joins it; otherwise one new theme per distinct rule, with
 *    `parents[rule]` (a label) naming its parent theme when that label is an existing theme
 *  - judge: `judgements[rule] = { relation, needle }` -> the first line containing needle
 *  - author (--infer-human): `[author:human]` in the text -> human; anything else -> not-human
 *  - `failOn: tool` answers that tool with no tool call every time; `failOnce: tool` only the first time
 */
export function recordingRuntime({ judgements = {}, parents = {}, failOn = null, failOnce = null } = {}) {
  const requests = [];
  const failedOnce = new Set();
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
      if (failOnce === tool && !failedOnce.has(tool)) {
        failedOnce.add(tool);
        return result(null, null);
      }
      if (tool === "record_turn_classifications") {
        const items = promptJson(prompt, "MESSAGES_JSON:").map(({ i, text }) => {
          const tag = /\[fix:([a-z-]+):([a-z]+):(\d)\]/.exec(text);
          const oneoff = /\[oneoff:([a-z-]+)\]/.exec(text);
          if (tag) return { i, kind: tag[2], pain: Number(tag[3]), rule: THEME_RULES[tag[1]], general: true };
          if (oneoff) return { i, kind: "correction", pain: 1, rule: THEME_RULES[oneoff[1]], general: false };
          return { i, kind: "none", pain: 0, rule: "", general: false };
        });
        return result(tool, { items });
      }
      if (tool === "assign_rule_themes") {
        const existing = new Map(promptJson(prompt, "EXISTING_THEMES_JSON:").map(({ id, label }) => [label, id]));
        const rules = promptJson(prompt, "RULES_JSON:");
        const created = new Map();
        const assignments = rules.map(({ i, rule }) => {
          if (existing.has(rule)) return { i, theme: existing.get(rule) };
          if (!created.has(rule)) created.set(rule, `new${created.size}`);
          return { i, theme: created.get(rule) };
        });
        return result(tool, { new_themes: [...created].map(([label, key]) => ({ key, label, parent: existing.get(parents[label]) ?? null })), assignments });
      }
      if (tool === "record_message_authors") {
        const items = promptJson(prompt, "MESSAGES_JSON:").map(({ i, text }) => ({ i, author: text.includes("[author:human]") ? "human" : "not-human" }));
        return result(tool, { items });
      }
      if (tool === "judge_rule_against_file") {
        const rule = JSON.parse(/PROPOSED_RULE_JSON: (.+)/.exec(prompt)[1]);
        const wanted = judgements[rule];
        if (!wanted) return result(tool, { relation: "none", line: null, explanation: "unrelated" });
        const line = promptJson(prompt, "RULE_FILE_LINES_JSON:").find(({ text }) => text.includes(wanted.needle));
        return result(tool, { relation: wanted.relation, line: wanted.line ?? (line ? line.line : 9999), explanation: `${wanted.relation} by fixture` });
      }
      throw new Error(`unexpected tool ${tool}`);
    },
  };
}

/** `n` sessions, each with the given human turns between assistant replies, one day apart, ending before NOW_MS. */
export function sessionsWith(perSession, { firstDay = 20, idOffset = 0, cwd } = {}) {
  return perSession.map((texts, n) => ({
    id: sessionId(idOffset + n + 1),
    ...(cwd ? { cwd } : {}),
    startMs: NOW_MS - (firstDay - n) * DAY_MS,
    turns: texts.flatMap((text) => (typeof text === "string" ? [{ role: "assistant", text: "Here is what I did." }, { text }] : [{ role: "assistant", text: "Here is what I did." }, text])),
  }));
}

/**
 * One Codex rollout in the line shape Codex writes (as kits/knowledge/promote/fixtures/runtime/codex-rollout.jsonl).
 * `source` is `session_meta.source`: `cli` (Ferry: human), `vscode` (unknown), `subagent` (agent). A turn with
 * `provenance: "agents_md"` (or `hook: true`) carries the metadata Ferry reads as harness (or hook) text, with no
 * envelope. Turns: `{ role?: "assistant", text, provenance?, hook? }`.
 */
export function codexSession(id, startMs, turns, { source = "vscode", cwd = CWD } = {}) {
  const at = (n) => new Date(startMs + n * 60_000).toISOString();
  const lines = [{ timestamp: at(0), type: "session_meta", payload: { id, session_id: id, timestamp: at(0), cwd, originator: "codex_vscode", cli_version: "0.130.0", source, model_provider: "openai", git: { branch: "main" } }, ordinal: 1 }];
  turns.forEach((turn, n) => {
    const role = turn.role === "assistant" ? "assistant" : "user";
    const payload = { type: "message", id: `m${n}`, role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text: turn.text }] };
    if (turn.provenance || turn.hook) {
      payload.internal_chat_message_metadata_passthrough = { content_item_kinds: ["text"], content_item_metadata: [{ provenance: { type: turn.provenance ?? "harness", ...(turn.hook ? { hook: true } : {}) } }] };
    }
    lines.push({ timestamp: at(n + 1), type: "response_item", payload, ordinal: n + 2 });
  });
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export const codexId = (n) => `019a0000-0000-7000-8000-${String(n).padStart(12, "0")}`;
