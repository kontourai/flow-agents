---
name: "standards-authoring"
description: "Author or update a repo's Veritas Repo Standards through the kit's standards-authoring flow: run `veritas init --explore`/`--guided` to derive a proposed starter set (project name, repo-shape-adaptive Repo Map nodes, evidence-check inference, and the AGENTS.md/CLAUDE.md governance-block splice), surface it for human approval, then `veritas init --apply` once a human-approved standards-authoring-approval trust.bundle claim satisfies the flow's human-approval gate. Use when adopting Veritas governance in a repo or re-deriving standards after its shape changes — beyond the static starter set `kit provision` scaffolds."
---

# Standards Authoring

Derive a repo's Veritas Repo Standards, get a human to approve them, then write them — the
authoring UX `veritas init` provides, driven through the kit's `standards-authoring` flow so
the write is human-gated.

**Veritas does the derivation and the write; this skill only invokes the `veritas` CLI and
surfaces its recommendation for approval.** No standards evaluation, derivation, or splice
logic is reimplemented here (kit non-goal: never fork or reimplement Veritas).

## When to use this vs. `kit provision`

- **`flow-agents kit provision veritas-governance`** copies a *static* starter `.veritas/` set
  (placeholder project name, generic nodes) — fastest path to a repo that runs
  `veritas readiness`. See the kit README's "Scaffolding starter standards".
- **This skill** runs Veritas's *adaptive* authoring: it derives the project name, Repo Map
  work-area nodes, and evidence-check command from the actual repo, and splices the governance
  block into existing `AGENTS.md`/`CLAUDE.md` — the per-repo work a verbatim file copy cannot
  do. Use it to author standards for real, or to re-derive after the repo's shape changes.

## Flow binding

This skill documents how to drive `flows/standards-authoring.flow.json` — a two-step
**agentless-gate** flow `propose -> apply` with one gate (the kit declares no
`flow_step_actions`; like `exemption-issuance`, the human produces the gate's approval bundle
out of band, and this skill is the operator's runbook, not a step-bound action):

- `human-approval-gate` (on `apply`) requires a **verified** `standards-authoring-approval`
  trust.bundle claim (`subjectType: "repo-governance-change"`) before the apply write is
  flow-sanctioned.

As with `exemption-issuance`'s `human-approval-gate`, "human-approved" is an **operating
convention** the gate's claim encodes, not a structural human-only guarantee — Flow's schema
does not distinguish a human-authored bundle from an agent-authored one (see the kit README's
"Human-approval evidence: what is and is not enforced"). The gate adds a named claim, a
documented sequence, and an audit trail on top of the same mitigation `veritas init --apply`
already carries (it refuses to overwrite existing standards without `--force`).

## Sequence

```bash
# 1. PROPOSE — derive a recommendation without writing anything.
veritas init --explore
#    (or `veritas init --guided --answers <answers.json>` for owner Q&A)
#    -> writes a hash-pinned recommendation artifact (schema_version, project_name,
#       repo_insights, artifact_payloads incl. AGENTS.md/CLAUDE.md governance blocks,
#       artifact_hashes, recommended_repo_map/standards/authority, owner_questions,
#       reasoning_summary, apply_command). Nothing under .veritas/ is written yet.

# 2. APPROVE — a human reviews the recommendation (its reasoning_summary and owner_questions),
#    then authors a Hachure trust.bundle asserting the approval:
#      claimType: "standards-authoring-approval", subjectType: "repo-governance-change",
#      status: "verified".
flow init
flow start kits/veritas-governance/flows/standards-authoring.flow.json --run-id authoring
flow attach-evidence authoring --gate human-approval-gate --file approval.bundle --bundle
flow evaluate authoring --gate human-approval-gate --exit-code
#    exit 0 once the approval claim is verified; exit 1 (block) otherwise.

# 3. APPLY — only after the gate passes, write the approved recommendation.
veritas init --apply --plan <path-to-recommendation-artifact>
#    -> validates each artifact_hashes[path] === sha256(payload) (tamper/staleness check
#       between propose and apply), refuses to overwrite existing starter files without
#       --force, then writes .veritas/* and splices the governance block into the selected
#       instruction files.
```

## Contract

- **Wraps the `veritas` CLI; reimplements nothing.** Project-name derivation, adaptive Repo Map
  nodes, evidence-check inference, and the governance-block splice all live inside `veritas`
  (`veritas init` / `src/bootstrap/*` / `src/governance.mjs`). This skill invokes and surfaces;
  it does not compute standards.
- **The write is human-gated by convention, not structurally.** The flow's
  `standards-authoring-approval` claim is the sign-off record; anyone who can
  `flow attach-evidence --bundle` a conforming claim satisfies it. Read a passing gate as "a
  verified approval claim of the right shape was attached," not as proof a human attached it.
- **`veritas init --apply` is create-safe by default:** it refuses to overwrite existing
  `.veritas/` standards without `--force`. Re-authoring an already-governed repo is therefore an
  explicit, opt-in action — the skill never silently replaces standards.
- **No engine dependency, no evaluation.** Nothing here runs or reimplements `veritas readiness`;
  that stays the `readiness-check` flow's concern.
