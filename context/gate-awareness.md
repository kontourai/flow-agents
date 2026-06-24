# Gate Awareness

This repo runs three active gates implemented as Claude Code hook scripts. Every agent working here should know when each gate fires, what it checks, and what the correct posture is when a gate blocks or when a suspected block does not appear.

## Active Gates

**goal-fit/Stop** (`scripts/hooks/stop-goal-fit.js`): fires on the agent Stop event (before the agent final-answers as complete). The gate reads `.flow-agents/` to find the most recent active workflow artifact and checks for: an incomplete Definition Of Done section, an incomplete or absent Goal Fit Gate section, open items in Final Acceptance when status is delivered, failing or NOT_VERIFIED checks in `evidence.json`, open sidecar issues (state.json showing non-done status, critique.json with open findings), and evidence cross-reference failures (the capture log in `command-log.jsonl` contradicting a claimed-pass command check in `evidence.json`). In `block` mode the gate exits 2, which prevents the Stop. The canonical engine default is `warn` (exit 0 with guidance on stderr); shipped runtime configs such as Claude Code at L2 set `block` so the installed product enforces. The gate releases automatically after a configurable number of consecutive identical blocks (default 3) to surface the situation to the human rather than looping forever.

**evidence-capture** (`scripts/hooks/evidence-capture.js`): fires as a postToolUse hook on every shell or command tool execution. It deterministically records the actual command result — not the model's narration about it — to `.flow-agents/<slug>/command-log.jsonl` as an append-only JSONL log. Each record captures the command string, observed result (pass/fail), exit code when available, and a timestamp. Non-blocking; always exits 0. Fail-open: a capture failure never blocks the agent or corrupts the log.

**reground** (`scripts/hooks/workflow-steering.js`): fires on `SessionStart` and `UserPromptSubmit` to re-inject the active workflow phase, goal, and next-step from `state.json` into the agent turn. This is what keeps an in-flight goal alive through context compaction and session resume without requiring the agent to voluntarily re-read sidecars. The hook also fires after subagent calls (use_subagent) to inject phase-transition reminders tailored to the completing subagent (planner, worker, reviewer, verifier). Non-blocking; always exits 0.

## A Block Is The System Working

When the goal-fit/Stop gate blocks, that is the system functioning correctly, not an obstacle to route around. The gate blocked because it found a genuine gap: an open Definition Of Done item, a failed evidence check, a sidecar showing non-done status, or a command the capture log shows actually failed while the evidence claims it passed. Routing around the block, silencing the hook, or suppressing the exit code treats a functioning quality gate as an error to ignore. It is not. Address the gap the gate named.

## Judge Gate Correctness

A block demands evaluation, not blind obedience and not blind routing-around. When the goal-fit/Stop gate fires, ask: is this a true-block or a false-block?

A true-block is a case where the gate is correct: a real gap exists — an unchecked Definition Of Done item, a command that genuinely failed, a missing sidecar, an open review finding — and the system is right to prevent delivery until the gap is closed. The correct response to a true-block is to close the gap, then re-attempt.

A false-block is a case where the gate has a genuine bug or is acting on stale or corrupt data — for example, a sidecar that was incorrectly written, a `command-log.jsonl` entry that misrecorded a passing command as a failure due to a capture-hook defect, or a `state.json` that was never updated to `done` even though the work is complete.

The path to a clean pass is always to **produce real evidence**, never to make the proof say what you want: run the command so the capture hook records the real result, finish the missing Definition-of-Done item, write the sidecar the flow forgot. Proof artifacts are not yours to hand-author into a pass — `command-log.jsonl` is owned by the capture hook and must never be hand-edited, and a verdict you write for yourself is not evidence of anything. Correcting a genuinely-wrong artifact is a last resort: do it transparently, note it as a correction, and prefer regenerating it through the tool that owns it. If the only way you can see to clear a block is to edit the proof, that is the signal to stop and surface the situation, not to proceed.

Do not conflate "inconvenient" with "false-block." If the gap named by the gate is real, it is a true-block regardless of how close to done the work feels.

## Missed-Block Diagnostic

When a gate does not fire and you suspect it should have, the gate is almost never defective. The goal-fit/Stop gate only knows what the flow recorded in `.flow-agents/<slug>/`. It cross-references `evidence.json` command checks against `command-log.jsonl`. A suspected missed block nearly always means the flow did not record the evidence, not that the gate failed to evaluate it.

Start diagnosis here:

1. Check `.flow-agents/<slug>/command-log.jsonl` — was the relevant command captured? If the evidence-capture hook was not active when the command ran (for example, the session predated the hook or the artifact directory was not yet resolved), the log will have no entry for that command and the Stop gate will see no contradiction to raise.
2. Check `.flow-agents/<slug>/evidence.json` — does the relevant check exist with kind `command` and status `pass`? The gate only cross-references checks that are explicitly recorded in `evidence.json` as command-kind claimed passes. If the check was never written there, the gate has nothing to cross-reference.
3. If both files are present and consistent but the block still did not fire, verify that the artifact directory the gate found is the one you expect (`state.json` newest-mtime resolution) and that the workflow artifact has the correct type and status to be treated as active.

A gate defect is a last resort diagnosis, not a first assumption.
