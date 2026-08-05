# Trigger-Spawned Agent Run Guards Contract

> Read [`context/contracts/standing-directives.md`](standing-directives.md) — ratified owner directives that override default engineering conservatism.

Any kit, hook, or integration that spawns an agent run from a trigger MUST declare, before it ships, how that spawn surface is guarded against runaway amplification. A trigger with no dedup, cooldown, cap, or concurrency guard converts one flapping upstream signal into an unbounded stream of agent runs — each of which may hold permissions, spend budget, and mutate state without a human turn in the loop. A 2026-07 field near-miss made this concrete: an on-failure escalation wired without these guards would have spawned a continuous stream of permission-skipping agent runs from a single flapping check. This contract makes the guard requirements standing suite policy so the next trigger-driven feature inherits them by default instead of rediscovering them in an incident.

## Scope

A **trigger-spawned agent run** is any agent execution started by an event rather than by a human request in an interactive session: a check or CI failure escalation, a schedule firing, a watcher or automation trigger, or any other perimeter event that launches headless agent work.

Out of scope:

- `workflow_triggers` in kit.json — in-session workflow steering for an already-running interactive session. Steering routes an existing session; it does not spawn a run.
- Subagent delegation inside an active, human-initiated session — the session itself is the supervision boundary.

No flow-agents hook spawns agent runs today (all four hook policy classes are advisory/steering), but the suite's perimeter already does, and in-repo consumers are planned (see "Future consumers" below). The contract applies the moment a surface CAN spawn a run, not the moment it misbehaves.

## Required Guard Declarations

Every trigger surface that spawns agent runs declares all four guards, with explicit values. The defaults below are the starting point when the feature has no measured reason to differ; declaring a weaker value than the default requires a recorded rationale on the owning work item.

| Guard | Field | Meaning | Default |
| --- | --- | --- | --- |
| Dedup | `dedup_key` | The trigger-signature expression used to suppress duplicate spawns while an equivalent run is pending or was recently spawned. For failure escalations: subject plus normalized failure signature (e.g. `check-name+failure-signature`), so a repeat of the same failure does not spawn a second run. | subject + trigger signature |
| Cooldown | `cooldown_seconds` | Minimum seconds between spawns for the same subject, regardless of signature churn. | `900` |
| Daily cap | `daily_cap` | Maximum spawns per trigger surface per day; the surface goes quiet (with a visible, non-silent skip) once reached. | `20` |
| Concurrency lock | `max_concurrent` | Maximum runs from this surface allowed to exist simultaneously, expressed as a limit; `1` is a mutual-exclusion lock. | `1` |

A skipped spawn (dedup hit, cooldown window, cap reached, lock held) must be observable — logged or counted, never silently dropped — so a guard absorbing real signal is diagnosable.

## Kit Declaration: `agent_spawn_triggers`

Kits declare agent-spawning trigger surfaces in kit.json through the optional `agent_spawn_triggers` extension field (Flow Agents extension-layer metadata, like `dependencies` and `workflow_triggers`):

```jsonc
"agent_spawn_triggers": [
  {
    "id": "on-check-failure",
    "description": "Escalates failing checks to a headless agent run.",
    "spawns_agent_runs": true,
    "guards": {
      "dedup_key": "check-name+failure-signature",
      "cooldown_seconds": 900,
      "daily_cap": 20,
      "max_concurrent": 1
    }
  }
]
```

- `id`: unique identifier (`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`).
- `description`: non-empty human-readable purpose of the surface.
- `spawns_agent_runs`: required boolean. `false` documents a trigger surface that fires without spawning agent runs (e.g. notification-only); such entries need no guards.
- `guards`: required-complete when `spawns_agent_runs` is `true` — all four fields, `dedup_key` a non-empty string, the three numeric guards integers >= 1.

Hooks and integrations that live outside a kit manifest declare the same four guards, with the same vocabulary, in their own configuration or design artifact.

## Enforcement

Kit repository validation emits a **WARNING** (not an error) when an `agent_spawn_triggers` entry has `spawns_agent_runs: true` and missing or incomplete `guards`. Malformed declarations (wrong types, duplicate ids, non-positive limits) are shape ERRORS like every other extension field.

Warning-level enforcement is deliberate, declaration-first rollout: the declaration is new and optional, and no in-repo surface spawns runs yet. When the first in-repo trigger-spawned runner ships, its surface must declare complete guards, and enforcement for spawning surfaces hardens with it (validation error and/or runtime refusal). Runtime guard enforcement is explicitly NOT part of this contract's first iteration — no spawning or guard machinery exists in this repo yet, and per standing directive 4 (standalone-first), the enforcement runtime belongs with the first real spawner.

## Conforming Examples

- **kontourai/plumb#1** — check-failure escalation to a headless agent with per-subject cooldown, failure-signature dedup, and a max-concurrent cap: the direct antecedent of this contract's `cooldown_seconds`, `dedup_key`, and `max_concurrent` guards.
- **ephemeris** — trigger firing that is coalesced per claim, idempotent, and rate-limited: dedup and cap expressed as coalescing plus rate limits, showing the guards generalize beyond failure escalation.

Both are cited as reference implementations of the guard vocabulary; consult their current sources when implementing a new surface.

## Future Consumers

The autonomy epic's background-review fork — kontourai/flow-agents#252, under epic #250 — will spawn agent runs from a trigger. Any implementation of #252 MUST declare its guard configuration under this contract (an `agent_spawn_triggers` entry with complete `guards`, or the equivalent declaration in its owning design artifact) before it ships.
