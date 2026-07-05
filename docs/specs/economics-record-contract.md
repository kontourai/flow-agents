# `kontour.console.economics` — per-run economics record contract (v0.1)

**Status:** ratified (flow-agents #349). **Kind:** `kontour.console.economics`. **Version:** `0.1`.

## Purpose

Every kit-driven run emits exactly one **per-run economics record** — cost, time,
iterations, and defects caught — so that "flow kits save money and produce more accurate
results" is a **measurable, falsifiable** claim backed by data. This record is the
measurement substrate for the Kit-economics telemetry initiative (I32–I35): it is
consumed by the baseline harness (#350), the small-model headline (#409), and the console
value view (console #117).

## Architecture (console ADR 0003)

- **Call 1 — additive kind on one pipe.** `kontour.console.economics` is a new *versioned
  record KIND* that rides the single authenticated ingress (`ApiSink`, `POST /records`)
  alongside `kontour.console.event`, `.projection`, and `.liveness`. It is **never** a new
  endpoint or a new auth path.
- **Call 2 — tenant is bound from the verified principal.** The `ApiSink` stamps the
  authoritative tenant from the request principal. The emitter MAY carry `tenant_id`
  (from `CONSOLE_TENANT_ID`) for **self-description only**; the emitter is never the source
  of truth for tenancy.
- **Call 3 — immutable fact, rollups are projections.** This record is an **immutable
  per-run fact**. The console-side economics rollups and the value view are **rebuildable
  projections** over the stream of these records. flow-agents emits facts, never a rollup;
  this emitter computes **no cross-run aggregate**.
- **Call 6 — local-first, best-effort.** The record is **always** written to the local log
  channel first; the console POST is a **detached, fail-open** fire that can never block or
  fail a run. Every failure path is a quiet `exit 0`.

## Record shape

```json
{
  "schema": "kontour.console.economics",
  "version": "0.1",
  "run_id": "string",
  "at": "epoch-millis string",
  "task_slug": "string|null",
  "model": "string",
  "pricing_version": "string|null",

  "cost": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "estimated_cost_usd": 0.0,
    "by_model": []
  },

  "time": {
    "wall_clock_s": 0,
    "human_wait_s": 0
  },

  "phases": [
    { "phase": "plan|execute|review|verify|unattributed",
      "input_tokens": 0, "output_tokens": 0,
      "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
      "estimated_cost_usd": 0.0, "wall_clock_s": 0 }
  ],

  "iterations": {
    "count": 1,
    "route_backs": 0
  },

  "defects": {
    "gate_fires": 0,
    "findings_by_severity": { "critical": 0, "high": 0, "medium": 0, "low": 0 },
    "caught_false_completions": 0,
    "verification_verdict": "PASS|FAIL|NOT_VERIFIED"
  },

  "tenant_id": "string|null"
}
```

## Field sources

Every field derives from a named telemetry event, usage field, or sidecar file. The emitter
**never re-estimates tokens** — ground truth is the transcript's `.message.usage` blocks,
already parsed by `usage_parse_transcript` (scripts/telemetry/lib/usage.sh) and carried on
the `session.usage` event.

| Field | Type | Source |
| --- | --- | --- |
| `schema` | literal | `"kontour.console.economics"` |
| `version` | literal | `"0.1"` |
| `run_id` | string | `session.usage .session_id` |
| `at` | epoch-millis string | `session.usage .timestamp` (session end) |
| `task_slug` | string\|null | `state.json .task_slug` |
| `model` | string | `session.usage .usage.model` |
| `pricing_version` | string\|null | `session.usage .usage.pricing_version` (from `pricing.json` `current_version`) |
| `cost.input_tokens` | int | `session.usage .usage.input_tokens` (transcript ground truth) |
| `cost.output_tokens` | int | `session.usage .usage.output_tokens` |
| `cost.cache_creation_input_tokens` | int | `session.usage .usage.cache_creation_input_tokens` |
| `cost.cache_read_input_tokens` | int | `session.usage .usage.cache_read_input_tokens` |
| `cost.estimated_cost_usd` | number | `session.usage .usage.estimated_cost_usd` (derived; recomputable console-side from `pricing_version`) |
| `cost.by_model` | array | `session.usage .usage.by_model`, verbatim |
| `time.wall_clock_s` | int | `session.usage .usage.duration_s` |
| `time.human_wait_s` | int | elapsed time blocked on a human decision (slice-1: `0` if uninstrumented; **never omit the key**) |
| `phases[]` | array | per-phase attribution — see the phase-sum invariant below |
| `iterations.count` | int | deliver-loop passes (plan→execute→review→verify); slice-1 default `1` |
| `iterations.route_backs` | int | verify FAIL → re-plan/re-execute loops; slice-1 default `0` |
| `defects.gate_fires` | int | count of gate fires in the run |
| `defects.findings_by_severity` | object | grouped from `critique.json .critiques[].findings[]` on `.severity` (missing → `low`) |
| `defects.caught_false_completions` | int | claimed-pass ACs contradicted by trusted-backstop re-runs (DISTINCT counter) |
| `defects.verification_verdict` | enum | final verify-work verdict from the sidecar (`PASS`\|`FAIL`\|`NOT_VERIFIED`) |
| `delegations[]` | array | per-sub-agent delegation facts (#415 slice 1) — see below; `[]` when `--agents-dir` is absent |
| `tenant_id` | string\|null | self-description only; the `ApiSink` stamps the authoritative tenant (ADR 0003 call 2) |

## `delegations[]` — per-sub-agent routing facts (#415 slice 1)

When the emitter is given `--agents-dir <slug>/agents`, it assembles one entry per delegated
sub-agent, joined from each `<slug>/agents/<agent-id>/events.jsonl`:

| Field | Type | Source |
| --- | --- | --- |
| `agent_id` | string\|null | the sub-agent id (join key) |
| `role` | string | routing role recorded on the delegation event (`delegate-mechanical`\|`delegate-implementation`\|`delegate-design`\|…) |
| `resolved_model` | string | the model that role resolved to (`.datum/config.json`), e.g. `claude-haiku-4-5@anthropic` |
| `summary` | string\|null | the delegation/escalation event's free-text summary (stands in for a structured task_type until slice 1b) |
| `escalated_from` | string | present only when the sub-agent escalated: the lower tier it was promoted from |

**Assembly rule:** for each `agent_id`, the **latest** `delegation`/`escalation` event wins (an
escalation supersedes the initial delegation and carries `escalated_from`); events lacking `role`
or `model`, and non-delegation events, are ignored. Any read/parse failure degrades to `[]` — never
fatal (local-first, best-effort).

**Deliberately a FACT, not a rollup (ADR 0003 call 3).** `delegations[]` records *which sub-agent
ran on which model*, nothing more. It carries **no per-delegation cost or outcome**: telemetry does
not isolate per-sub-agent token usage today, so inventing a per-delegation cost split would be
fabrication. Cost attribution and routing-efficiency review are downstream:

- **cost per `(role, model)`** is a *console projection* — join `delegations[]` (role→model) against
  the existing `cost.by_model` (which is 1:1 with roles under the current `.datum/config.json` map).
- **per-delegation `outcome`** (`accepted`\|`rework`\|`diverged`\|`failed`) is **slice 1b** — it needs
  per-sub-agent usage isolation and an evidence-derived outcome (verdict + supersession), not
  self-report.

## R7 Goodhart guard (structural, hard requirement)

`cost` and `defects` are **co-required** in the JSON Schema
(`"required": ["schema","version","run_id","cost","time","iterations","defects"]`). A record
with `cost` but no `defects` block is **schema-invalid**. This is structural: **no consumer
can render "cheaper" without also rendering "and here is what it caught / missed."** Cost is
only meaningful paired with the defect signal it traded against — the Goodhart pair.

## Phase-sum invariant

The sum over `phases[].input_tokens` (and each other token / cost / wall field) MUST equal
the corresponding top-level `cost` / `time` total. When no phase context exists in
`state.json`, **all** amounts land in a single `{"phase":"unattributed", ...}` entry — never
silently dropped or misattributed. The eval asserts this invariant for both the
phase-known and phase-unknown fixtures.

## Version semantics

`version` is the record-shape version, independent of `pricing_version` (which versions the
cost derivation). A shape change bumps `version`; a pricing change bumps `pricing_version`.
Because the record stream is immutable and tenant-stamped, shape evolution is a
**re-projection** console-side, not a migration of authority.

## Emission (local-first, best-effort)

1. The record is assembled with a **single `jq -c` filter** so every untrusted field
   (`task_slug`, model names, finding text) is `\u`-escaped — JSON is never string-built.
2. The record is written to the local economics log
   (`${TELEMETRY_ECONOMICS_LOG_FILE:-<TELEMETRY_DATA_DIR>/economics.jsonl}`) **first**.
3. Only then is the record best-effort POSTed to `<console>/records` via the shared
   `console_post_json` transport core — detached, fail-open, opt-in
   (`FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY`) and only when a console endpoint is configured.
4. Every failure path is `exit 0`. The emitter only writes/relays a fact — it never mutates
   a kit, gate, or claim (render-don't-execute).
