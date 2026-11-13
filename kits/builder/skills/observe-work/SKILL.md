---
name: "observe-work"
description: "Observe-and-remind Builder profile: write the plan and acceptance.json as files, work freely, and let the Stop hook remind you of exactly what is unmet."
---

# Observe Work

## Role

This is the Builder step skill for the `builder.observe` flow (observe mode). You are trusted to
do the work. The flow declares what must be true when you are done, hooks observe what actually
happens, and the Stop hook tells you exactly what is still unmet. You do not submit evidence or
drive workflow state. Decision record: `docs/decisions/observe-mode.md`.

## Outputs

This step produces two artifacts, as files the gate reads: `<slug>--plan-work.md` and
`acceptance.json`. Their expectations are derived by the harness, not submitted.

## Binding

| Context | Binding | Flow expectations |
| --- | --- | --- |
| Active observe run | `builder.observe` at `verify` | `acceptance-definition`, `implementation-scope`, `tests-evidence`, `acceptance-criteria` (all derived), `clean-critique` (recorded by a separate reviewer) |
| Standalone invocation | No Flow binding | No workflow mutation. |

## Procedure

1. Start once: `flow-agents workflow start --flow builder.observe --task-slug <slug> --criterion "<criterion>"`.
   This records the base commit that scope is measured from. It is not an evidence submission.
2. Write `<slug>--plan-work.md` in the session directory with an `## Expected Modified Files`
   list (paths, directories ending in `/`, or globs). Put anything you cannot decide under
   `## Open Questions`; those go to the human, they never block you.
3. Edit `acceptance.json`: give every criterion a command evidence ref that proves it,
   `{"kind": "command", "excerpt": "<runnable command>"}`, and optionally `"file"` naming the test it
   runs. At least one check must be a real test run. A criterion that no command can prove is
   `"status": "accepted_gap"` with `"notes"` explaining why; it goes to the human.
4. Work freely. Run whatever you like. Commit your work: checks only count against a committed tree.
5. Ask a separate reviewer session (`review-work`) to review the committed head and record
   `workflow critique`. The implementing session cannot review its own work.
6. Stop when you believe the work is done. If anything is unmet, the Stop hook lists it, with the
   file and criterion and the last observed result. Fix those items and stop again.

## Rules The Hook Enforces

- At the first Stop, each criterion's check is **locked**: its command and the test files and
  package scripts it runs are hashed. Editing a locked check does not change what runs. Editing a
  locked test file is reported. Revert it, or give a one-line reason under `## Check Changes`.
  The human sees that reason.
- A file changed outside `## Expected Modified Files` needs a one-line reason under
  `## Scope Changes`, as `` - `path`: reason ``.
- The hook re-runs a locked check that has no result at the current commit, within a time
  budget. For a slow suite run `flow-agents observe verify`.
- After a bounded number of reminders, or a Stop with no progress, the hook hands the remaining
  items to the human with a summary instead of reminding you again.

`flow-agents observe status` shows what is left. It is optional and never required to pass anything.
