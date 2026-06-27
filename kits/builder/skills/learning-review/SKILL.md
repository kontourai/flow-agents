---
name: "learning-review"
description: "Capture post-merge, post-deploy, or post-incident learnings and feed them back into backlog, workflow skills, tests, docs, or knowledge. Use after release readiness, post-deploy checks, retrospectives, failed gates, or repeated workflow friction."
---

# Learning Review

Turn delivery outcomes into durable learning and follow-up work.

## Contract

- Do not rewrite history or mark failed work as successful.
- Do not implement fixes during the review.
- Capture facts, decisions, and follow-up issues separately.
- Feed actionable changes back to `idea-to-backlog`, GitHub issues, tests, docs, or knowledge.
- Use `knowledge-capture` or `observe` when the learning should persist beyond the repo.
- Compare long-lived docs against the local `.flow-agents/<slug>/` plan and the final acceptance artifact so implementation intent is not lost after merge.
- Treat `learning-review` as the terminal closeout decision point for correction telemetry. Compare intended behavior to observed behavior before writing `learning.json`, then record either `correction.needed: false` for a clean run or `correction.needed: true` for a mismatch.

## Inputs

- Release-readiness artifact, evidence-gate artifact, PR/issue links, deploy notes, incidents, telemetry, user feedback, and reviewer/verifier notes.

## Artifact Contract

Create or update `.flow-agents/<slug>/<slug>--learning-review.md` with:

- `scope`: delivered work, issue/PR/release links, dates
- `outcomes`: expected vs observed behavior and signals
- `evidence`: telemetry, support notes, incidents, CI/review patterns
- `decisions`: what changed, why, and who decided
- `gaps`: process, tests, docs, skill, tooling, product, or ownership gaps
- `followups`: GitHub issues, idea-to-backlog items, docs/tests/eval work
- `knowledge_updates`: notes captured or observations proposed
- `docs_promotion`: durable docs updated, source artifacts archived/linked, and gaps routed
- `runtime_artifact_cleanup`: `.flow-agents/` runtime artifacts remain untracked or a blocker is recorded
- `verdict`: LEARNED, FOLLOWUP_REQUIRED, or BLOCKED

When the repository provides `npm run workflow:sidecar --`, also write `learning.json` with:

```bash
npm run workflow:sidecar -- record-learning .flow-agents/<slug> \
  --status learned \
  --record-json '{"id":"...","source_refs":["release.json"],"outcome":"success","facts":["..."],"interpretation":"...","routing":[{"target":"none","action":"No follow-up required after intended-vs-observed closeout.","status":"completed"}],"correction":{"needed":false,"evidence":"Acceptance, release, docs promotion, and learning closeout behaved as intended."}}' \
  --summary "..."
```

Use `followup_required` or `blocked` when facts are captured but follow-up routing is still open.

Clean terminal runs must record a lightweight no-correction-needed record, not an invented lesson. Use `correction.needed: false`, a brief `correction.evidence` summary, and closed routing such as `target: "none"` with `status: "completed"`.

Mismatch terminal runs must record `correction.needed: true` with:

- `correction.type`: one of `workflow`, `skill`, `agent`, `tooling`, `test`, `doc`, `process`, `product`, `provider`, or `none`
- `correction.recurrence_key`: a stable free-form key for grouping repeated failures
- `correction.intended_behavior`: what the workflow, artifact, skill, agent, or provider was supposed to do
- `correction.observed_behavior`: what actually happened
- `correction.gap`: the difference between intended behavior and observed behavior
- `correction.prevention`: a routed prevention action, or `correction.no_change_rationale` when no change is intentionally made

If a correction-needed prevention route is still open, use `learning.status: followup_required` unless the route is already represented by a durable provider issue, deferred with a trigger, accepted, or rejected with a rationale.

After writing `learning.json`, run artifact validation when available. If `record-learning` is unavailable or blocked, keep the learning verdict at `FOLLOWUP_REQUIRED` or `BLOCKED` in the Markdown artifact and record the sidecar-write gap explicitly.

For Flow Agents repo changes, prefer the combined self-validation command when evidence and critique are part of the same pass:

```bash
npm run workflow:sidecar -- dogfood-pass \
  --check-json '{"id":"...","kind":"test","status":"pass","summary":"..."}' \
  --require-critique \
  --critique-id "..." \
  --critique-summary "..." \
  --learning-record-json '{"id":"...","source_refs":["evidence.json","critique.json"],"outcome":"success","facts":["..."],"interpretation":"...","routing":[{"target":"none","action":"No correction required.","status":"completed"}],"correction":{"needed":false,"evidence":"Evidence and critique matched the intended closeout behavior."}}'
```

Use `dogfood-pass` only when it can preserve the real evidence state. It must not turn `NOT_VERIFIED` or missing critique into a clean learning outcome.

## Workflow

### 1. Reconstruct Outcome

Compare the original intent, acceptance criteria, release decision, and post-deploy signals. Distinguish facts from interpretation.

### 1a. Decide Correction State

Before identifying durable learnings, write down the intended behavior, observed behavior, and any gap. If there is no gap, record `correction.needed: false`. If there is a gap, record `correction.needed: true` with typed `correction.type`, stable `correction.recurrence_key`, intended behavior, observed behavior, gap, and either a prevention route or an explicit no-change rationale.

### 2. Identify Learning

Classify learnings as product, technical, operational, workflow, test, documentation, eval, or agent-behavior learning.

### 3. Route Follow-Up

Route raw ideas or ambiguous improvements to `idea-to-backlog`. Create GitHub issues only for executable follow-up. Use `evidence-gate` again when unresolved trust questions remain.

### 4. Capture Durable Knowledge

Use `knowledge-capture` for durable project or relationship knowledge and `observe` for repeated agent workflow patterns or corrections.

### 5. Confirm Docs Promotion

Check whether accepted delivery artifacts were promoted into long-lived documentation and whether `.flow-agents/` runtime artifacts remained untracked before merge to `main`. If not, route the missing doc or cleanup work as an owned follow-up or explicitly record why the delivery was self-explanatory.

### 6. Close The Loop

Record which follow-ups were created, which were intentionally deferred, and what trigger should revisit deferred work.

## Gate Claims: Record Learning Outcomes

After `learning.json` is written and the learning verdict is `LEARNED` or `FOLLOWUP_REQUIRED`, record the two gate claims for the Builder Kit `learn` step. These satisfy the `builder.learn.decisions` and `builder.learn.evidence` gate expectations.

**Claim 1 — Decision evidence** (durable decisions from the build are recorded):

```bash
npm run workflow:sidecar -- record-gate-claim .flow-agents/<slug> \
  --expectation decision-evidence \
  --status pass \
  --summary "Build decisions recorded: <decision-count> decisions captured, correction.<needed> recorded." \
  --evidence-ref-json '{"kind":"artifact","file":".flow-agents/<slug>/learning.json","summary":"learning.json with decisions and correction state."}'
```

**Claim 2 — Learning evidence** (learnings from delivery are recorded for future work):

```bash
npm run workflow:sidecar -- record-gate-claim .flow-agents/<slug> \
  --expectation learning-evidence \
  --status pass \
  --summary "Learning evidence captured: <outcome> outcome, facts recorded, routing complete." \
  --evidence-ref-json '{"kind":"artifact","file":".flow-agents/<slug>/learning.json","summary":"learning.json with outcomes, facts, and routing."}'
```

Record both claims immediately after `record-learning` succeeds and artifact validation passes. Use `--status fail` when `record-learning` fails or when learning cannot be captured (verdict `BLOCKED`). Use `--status not_verified` only when the session has no active Builder Kit flow step.

When the learning verdict is `FOLLOWUP_REQUIRED`, record both claims with `--status pass` and name the open routing in the summary; the follow-up route is separate from gate satisfaction.



## Gates

- Learning Gate: observed outcome is recorded with evidence.
- Follow-Up Gate: every actionable gap is routed, owned, or intentionally deferred.
- Knowledge Gate: durable learning is captured in the right store.
- Docs Gate: accepted planning and final acceptance artifacts are archived and linked from durable docs when useful.
- Closure Gate: the artifact says what is done, what remains, and why.
- Correction Gate: every terminal learning review records whether correction was needed; clean runs do not invent lessons, and mismatch runs have a recurrence key plus prevention route or no-change rationale.
