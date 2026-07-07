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
| `delegations[]` | array | per-sub-agent delegation facts + derived outcome (#415) — see below; `[]` when `--agents-dir` is absent |
| `signals` | object | harness-capability declaration — what telemetry this runtime exposed (see below + `harness-capability-matrix.md`) |
| `tenant_id` | string\|null | self-description only; the `ApiSink` stamps the authoritative tenant (ADR 0003 call 2) |

## `delegations[]` — per-sub-agent routing facts + outcome (#415)

When the emitter is given `--agents-dir <slug>/agents`, it assembles one entry per delegated
sub-agent, joined from each `<slug>/agents/<agent-id>/events.jsonl`:

| Field | Type | Source |
| --- | --- | --- |
| `agent_id` | string\|null | the sub-agent id (join key) |
| `role` | string | routing role recorded on the delegation event (`delegate-mechanical`\|`delegate-implementation`\|`delegate-design`\|…) |
| `resolved_model` | string | the model that role resolved to (`.datum/config.json`), e.g. `claude-haiku-4-5@anthropic` |
| `summary` | string\|null | the delegation/escalation event's free-text summary (stands in for a structured task_type) |
| `escalated_from` | string | present only when the sub-agent escalated: the lower tier it was promoted from |
| `dispatch_count` | int | how many times the orchestrator (re)dispatched this agent_id (delegation + escalation events); `>1` = re-prompted |
| `outcome` | enum | `accepted`\|`rework`\|`diverged`\|`failed`\|`unavailable` — derived (see below) |

**Assembly rule:** all events for an `agent_id` are grouped; role/model come from the **latest**
`delegation`/`escalation` event (an escalation supersedes and carries `escalated_from`). Any read/parse
failure degrades to `[]` — never fatal (local-first, best-effort).

**Outcome — derived only from ORCHESTRATOR-OBSERVABLE signals, never fabricated.** The orchestrator
knows what it dispatched, how often it re-dispatched, and how it corrected — so outcome holds **without
peeking inside the sub-agent** (which most harnesses forbid — see `harness-capability-matrix.md`):

- `diverged` — an explicit supersession marker (`kind:"supersession"` or `status:"diverged"`) exists.
- `rework` — an escalation happened **or** the orchestrator re-dispatched the agent (`dispatch_count > 1`).
- `failed` — the latest terminal verdict event (`kind` `evidence`/`verdict`) is a FAIL.
- `accepted` — the latest terminal verdict is a PASS (and no escalation / re-dispatch / supersession).
- `unavailable` — no terminal verdict was recorded on this harness. **Not assumed `accepted`** — absence
  of a verdict is not evidence of success.

**Per-delegation COST is still not carried here.** Token usage is *sub-agent-internal* and no runtime
isolates it today (`signals.per_delegation_tokens = false`), so a per-delegation cost split would be
fabrication. Cost per `(role, model)` is a **console projection** — join `delegations[]` (role→model)
against `cost.by_model` (1:1 with roles under the current `.datum/config.json`), labeled model-granularity.

## `signals` — harness-capability declaration

Declares what telemetry the emitting runtime actually exposed, so a consumer distinguishes a real zero
from a harness-blind gap (full doctrine + per-runtime matrix in `harness-capability-matrix.md`):

| Field | Meaning |
| --- | --- |
| `runtime` | the runtime that produced the record (`claude-code`, `kiro-cli`, …), from `session.usage .agent.runtime` |
| `per_delegation_tokens` | `true` iff the runtime isolates per-sub-agent tokens. `false` everywhere today → per-delegation cost unavailable |
| `per_delegation_outcome` | outcome-signal coverage this run: `full`\|`partial`\|`none`\|`n/a` |

Consumers MUST read `signals` before rendering a delegation metric: if the needed signal is unavailable,
show "not measurable on this harness," never a misleading number.

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
   (`${TELEMETRY_ECONOMICS_LOG_FILE:-${TELEMETRY_DATA_DIR}/economics.jsonl}`) **first** — the
   fixed, non-doubled path (#469; `TELEMETRY_DATA_DIR` is already the fully-qualified
   `.../.kontourai/telemetry` data dir, so only `economics.jsonl` is appended to it, never a
   second `.kontourai/telemetry/...` suffix on top).
3. Only then is the record best-effort POSTed to `<console>/records` via the shared
   `console_post_json` transport core — detached, fail-open, and gated on
   `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` and only when a console endpoint is configured.
4. Every failure path is `exit 0`. The emitter only writes/relays a fact — it never mutates
   a kit, gate, or claim (render-don't-execute).
5. **Unattributed/no-signal suppression** (economics-relay-unattributed-suppression): the local
   write in step 2 is unconditional, but the console POST in step 3 is additionally suppressed —
   the run's fact still lands in the local `economics.jsonl`, it just never reaches the console —
   when the assembled record carries **none** of the following:

   ```
   suppress_relay =
         (task_slug is null/empty/"unattributed")
     AND (cost.estimated_cost_usd == 0)
     AND (no token volume — cost.input_tokens + cost.output_tokens
          + cost.cache_creation_input_tokens + cost.cache_read_input_tokens == 0)
     AND (defects.gate_fires == 0)
     AND (defects.caught_false_completions == 0)
     AND (sum of defects.findings_by_severity.* == 0)
   ```

   Any one of real task attribution, real cost, real token volume, or a real defect/gate signal
   is enough to still relay the record unchanged. The token-volume leg exists because cost
   legitimately degrades to `0` on an unpriced/new model (see `scripts/telemetry/lib/usage.sh`'s
   contract) while the transcript-ground-truth token counts remain a real signal — without this
   leg, a real, unattributed, unpriced-model run with genuine token volume would be
   indistinguishable from a truly-empty run and would be wrongly suppressed, dropping real ROI
   data.

   This guard exists because `telemetry.sh` invokes the emitter on every `session.usage` Stop
   event once usage tracking is on, regardless of whether the run had an active Builder task —
   with no `active_slug`, `task_slug` resolves to `null` (assembled as `state.task_slug // null`;
   it is never the literal string `"unattributed"` as *data* — that literal is only how the
   console *renders* a `null`/empty `task_slug` in its ROI view) and every `defects.*` field sits
   at its zero default, so without this guard every no-task, no-signal run relayed a `null`
   task_slug, `$0`-cost, zero-token, zero-defect record that diluted the console
   `/api/economics` ROI view's `firstPassRate` and cost aggregates. The `!= "unattributed"` leg
   in the predicate is harmless defense-in-depth (in case an upstream caller ever passes that
   literal string), not a claim that the emitter itself produces it. `delegations[]`/`signals.*`
   are deliberately excluded from the predicate — `--agents-dir` is only ever passed alongside
   `--state`, so `delegations` is already `[]` whenever the other terms are at their zero
   defaults.

   **The guard itself fails OPEN toward relaying.** The suppress path only fires when jq
   successfully evaluates the predicate above to an explicit `false` (a genuinely-empty record);
   a jq/read failure (non-zero exit, or any output other than the literal `false`) falls through
   and the record RELAYS unchanged — dropping a real record is worse than an extra empty one
   reaching the console, so a guard failure never silently swallows real data. Set
   `TELEMETRY_ECONOMICS_DEBUG=1` to log a one-line `economics-record: suppressing console relay
   (...)` diagnostic to stderr whenever the guard actually suppresses a POST.

### Enabling the relay (config-driven, opt-out — #469)

The console relay is **on by default once a Console telemetry sink is configured** — it is no
longer env-var-only. `scripts/telemetry/lib/config.sh` resolves
`FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` as follows:

- An explicit `console_economics_relay` key in a trusted conf (`.kontourai/telemetry-console.conf`
  or `~/.flow-agents/telemetry-console.conf` — mode `600`, owned by the current user; see the
  telemetry-mirror trust gate in `docs/agent-usage-feedback-loop.md`) always wins: truthy
  (`1`/`true`/`yes`/`on`) forces the relay on, falsey (`0`/`false`/`no`/`off`) forces it off.
- Otherwise, once `console_telemetry_url` / `console_telemetry_endpoint_url` resolves (from that
  same trusted conf, or a directly-set env var), the relay **defaults on**.
- A caller-pre-set `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` environment variable is left untouched
  and takes priority over the default-on rule (but not over an explicit conf key).
- The optional `console_economics_endpoint_url` conf key (or the
  `FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL` env var) overrides the derived `<console>/records`
  endpoint when it must differ from the telemetry sink's origin.
- To opt out without hand-editing the conf, pass `--no-economics-relay` to
  `install-console-config.sh`, which writes `console_economics_relay=0`.

The raw `FLOW_AGENTS_CONSOLE_ECONOMICS_RELAY` / `FLOW_AGENTS_CONSOLE_ECONOMICS_ENDPOINT_URL` env
vars are still honored directly, for one-off invocations or CI where writing a conf file isn't
worth it — but the conf keys above are the normal path for an installed setup.
