# The learn loop: corrections you keep repeating

`flow-agents learn` reads your existing coding-agent transcripts, finds the corrections,
nudges and frustration **you** typed more than once, and turns each recurring one into a
proposal: a rule for `AGENTS.md`/`CLAUDE.md`, a skill, a hook, or an executable check. A
person ratifies, rejects or defers every proposal. Nothing is ever applied for you.

It needs no Flow run, no telemetry setup and no kit adoption: it reads the transcripts
Claude Code and Codex already keep (`~/.claude/projects`, `~/.codex/sessions`).

**Required version.** The loop counts only messages the transcript importer marks as typed by
a person, which needs `@kontourai/ferry` **0.8.0 or later** (with `@kontourai/thread` 0.7.0,
schema 1.3.0, which adds `Message.origin`). The Flow Agents package still pins Ferry 0.6.0
until the dependency bump lands; with it, `flow-agents learn` refuses with exit 2
(`LEARN_ORIGIN_UNAVAILABLE`) and `--dry-run` reports `origin-unavailable`.

Proposals use the `correction-recurrence` source family of the
[`kontour.learning-review-proposals` contract](../../../docs/specs/learning-review-proposals-contract.md)
(v0.2), so they share that contract's ledger, decision script and effect measurement with
the kit and gate tuning proposals.

## Quick start

```bash
flow-agents learn --dry-run            # counts only: no model call, nothing written
flow-agents learn --since 60d          # classify, cluster, propose
flow-agents learn --json > learn.json  # the full contract document
```

Run it inside the repository you want to learn for. Its `AGENTS.md` (or `CLAUDE.md`) at the
repository root is the file proposals target. Without either file the loop still proposes, but
it skips the conflict check and says so.

### Which sessions count

By default, only sessions recorded in **this repository** count. A transcript records the
directory its session ran in, and:

- a directory that still exists counts when Git says it belongs to the same repository (the
  same `git rev-parse --git-common-dir`). That includes every subdirectory and every linked
  worktree, and excludes a different repository nested under this one's path.
- a directory that no longer exists counts when its path is under the main checkout or a
  worktree Git still lists. A session from a worktree that has since been removed, and that lived
  outside those paths, cannot be attributed and is not counted.

Each worktree has its own default ledger, at that worktree's root. Its sessions, however,
cover every worktree of the repository. Run the loop from one checkout (or pass the same
`--ledger`) so proposals and their measurements accumulate in one place. Proposals record the
repository they were learned for (`scope`), and a run measures and builds on only the entries
of its own scope.

`--all-projects` reads every project on the machine. It prints a warning, because excerpts of
corrections you made in other repositories are then written into this repository's ledger.

Outside a Git repository, the loop refuses (exit 2) unless you pass `--all-projects`. Inside
one, it refuses to write its ledger or review queue anywhere Git would track or commit them
(`LEARN_LEDGER_TRACKED`): `.kontourai/` must be ignored, as it is in this repository.

The model is the Datum role `extraction-default`, the same role and route the
[dream run](dream.md) uses. A machine already set up for the dream needs nothing more; otherwise
see [Dream run model setup](README.md#dream-run-model-setup). Use `--role NAME` to choose another
role.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--since` | `30d` | `Nd`, `YYYY-MM-DD` (UTC) or an ISO-8601 timestamp. Anything else is refused. |
| `--dry-run` | off | Read and count only. No model call, no ledger, no review items. |
| `--all-projects` | off | Read every project, not just this repository (see above). |
| `--transcripts DIR` | the two harness directories | Repeatable. Every `*.jsonl` below it is read; symlinks are not followed. |
| `--ledger PATH` | `$LEARNING_REVIEW_PROPOSALS_LEDGER`, else `<worktree root>/.kontourai/telemetry/learning-review-proposals.jsonl` | The contract's ledger. |
| `--rules-file PATH` | `AGENTS.md`, else `CLAUDE.md`, at the worktree root | The file proposals target and are judged against. A symlink is followed to a regular file you own that no other user can write. |
| `--min-occurrences`, `--min-sessions`, `--min-high-pain` | 5, 3, 2 | The thresholds below. |
| `--json` | off | Print the contract document instead of the summary. |

Exit codes: 0 ran (including a dry run and too little history), 1 failed (including a ledger
another writer holds, or one whose decisions changed during the run), 2 usage or configuration
(no model set up, not in a repository, a corrupt or committable ledger, an unusable rules file,
or transcripts with no message origin).

## What it does

```
transcripts of this repository -> user messages whose origin is human -> drop continuation pings
  -> classify (model) -> keep general corrections, nudges and frustration
  -> cluster into themes (model) -> measure ratified proposals
  -> per theme: its history decides what may be proposed, and from when occurrences count
  -> threshold -> conflict check (model) -> proposals
  -> under the ledger lock: re-read, merge, write the review queue, then the ledger
```

Every model call happens before the lock is taken and before the first write. A malformed
model answer is asked for once more; a second one fails the run, which then writes nothing.
Transcript text and rule-file lines reach the model as JSON strings, so a message that
contains markup or something shaped like another message stays inside its own string.

### Only your own words count

A user message counts only when the transcript importer
([`@kontourai/ferry`](https://github.com/kontourai/ferry) 0.8.0 or later) says a person typed it:
`origin.kind === "human"`. Agent briefs, harness and hook injections, compaction summaries,
task notifications, `unknown`, and messages with no origin never count.

This is what keeps an orchestrator from looking like a person. An orchestrating agent repeats
its rules to every delegate it starts. Counted as user messages, those briefs look like
dozens of independent human corrections. Counting only `human` removes them by construction.

When no user message carries an origin at all (an older Ferry), a real run refuses with exit
2, and a dry run reports `origin-unavailable`, rather than reporting "no corrections".

### Two kinds of noise are removed on purpose

- **Continuation pings** ("continue", "still moving?", "ok") are dropped before any model call.
  The list is closed and in `learn/classify.js`.
- **Factual pushback** ("that function is in another file") is classified `none`, unless it also
  says how the agent should work.

There are no keyword or capital-letter heuristics. On a real corpus, keywords found
corrections with 13% precision and capital letters with 0%.

### Classification

Human turns are sent in batches of 20, each with the end of the agent's previous message as
context. For each turn the model returns a kind (`correction`, `nudge`, `frustration`, `none`),
a pain score from 0 to 3, the rule the turn implies in at most 15 words, and whether that rule
is **general** (a standing preference) or a one-off about the task at hand. Only general
corrections, nudges and frustration go on. A rule over 15 words, or a pain outside 0 to 3, is
refused and counted, not truncated.

### Themes and thresholds

The general rules are grouped into themes by the model. It sees the rules only, never your
message text, and the themes already in the ledger, so a theme keeps its id from one run to
the next. That stable id lets later runs recognize a proposal they already made and measure
its effect.

A theme becomes a proposal when either:

- it recurred at least **5** times across at least **3** sessions, or
- at least **2** of its occurrences were high pain (pain 3), in at least **2** sessions.

A new theme that narrows an existing one records it as its `parent`. Measurement and history
follow parents to the root theme, so a theme the model splits differently in a later run still
counts against the proposal that was ratified for it.

### What a theme's history allows

Only occurrences that the ledger's decisions have not already answered are counted:

| The theme's history (same repository) | What the run does |
| --- | --- |
| An open proposal (`proposed` or `deferred`) | Proposes nothing new. A theme never has two pending proposals; the open one is reported. |
| No decision yet | Counts every occurrence; may propose a prose rule. |
| Latest decision **rejected** | Counts only occurrences since the rejection. If they cross the threshold again, proposes again at the same rung under a new id. |
| Latest decision **ratified** | Counts only occurrences since the ratification. Proposes the next rung only when the ratified proposal has been **measured** as `worsened` or `unchanged`. Until then (no measurement, too little data, or `improved`) it proposes nothing. |

A window with fewer than 3 sessions containing human turns is reported as `insufficient-data`
and spends no model call.

### Enforcement: prose rule, then skill, then hook, then check

Each proposal recommends one rung of a ladder, and its target kind is that rung:

| Rung | `target.kind` | When |
| --- | --- | --- |
| 0 | `agents-md` | First proposal for a theme: add the rule to the rule file. |
| 1 | `skill` | A ratified prose rule was measured not to reduce the recurrence. |
| 2 | `hook` | A ratified skill was measured not to reduce it. |
| 3 | `veritas-check` | A ratified hook was measured not to reduce it: propose an executable check for the repository's Veritas config. |

Only a measurement climbs the ladder. A rule file that already says the same thing is reported
(`covered_by`) but is not, by itself, a reason to escalate.

`enforcement.reason` says why, and `enforcement.prior_proposal_ids` names the earlier proposals
for the theme.

### Conflicts with rules you already wrote

Each proposal's rule is checked against the rule file by a model judge. The judge cites one
line, and the loop checks that line exists and has text before accepting the answer.

- `conflict`: the line tells the agent something incompatible. The proposal says so, and its
  review item puts the written line and the learned rule side by side.
- `covered_by`: the line already says the same thing. The proposal says so; whether the written
  rule needs strengthening is for you to decide.

Lines are numbered after the whole file is scrubbed. A multi-line secret (a private key block)
becomes one `<SECRET>` line, so line numbers after one can differ from the file's.

On a real corpus, 2 of the 5 strongest learned rules contradicted rules already written down.
Neither is a reason to drop the proposal; both are for you to decide.

## Reviewing proposals

New proposals are appended to the ledger, and an open review queue is written beside it as
Survey `ReviewItem`s (`correction-recurrence.review-items.json`). The same proposal is never
appended twice: a later run marks it `already_proposed`.

Record your decision with the contract's decision script:

```bash
scripts/telemetry/learning-review-decide.sh .kontourai/telemetry/learning-review-proposals.jsonl \
  <proposal-id> --ratify|--reject|--defer --decided-by NAME [--rationale TEXT] [--follow-on-ref URL]
```

Ratifying records your decision; it changes no file. Adopting the rule, skill, hook or check is
your follow-up work.

### Did it work?

A ratified proposal is measured on each run whose window reaches back to its ratification,
once at least 14 days have passed since it. The measurement asks how many recurrences the
rate that triggered the proposal would predict for that period:
`expected = rate_per_week x days / 7`.

- Fewer than **3** expected: `insufficient-data`. A count that small cannot tell an improvement
  from chance.
- Observed at most `expected x 0.7`: `improved`. At least `expected x 1.3`: `worsened`. In
  between: `unchanged`.

This is a heuristic tolerance band, not a significance test. Zero recurrences is a measurement,
not a gap. The measurement is repeated on later runs as more time passes; the previous one moves
to `effect_history`, so one early sample is never final. A run with the same count over the same
whole number of days changes nothing.

### Writers take turns

`flow-agents learn`, `learning-review-proposals.sh` and `learning-review-decide.sh` take the same
exclusive lock (`<ledger>.lock`, the dream run's lock protocol) around their read-modify-write,
and wait up to `LEARNING_REVIEW_LOCK_TIMEOUT_MS` (default 10 s) for it. The learn loop does its
model work first and takes the lock only to write: it re-reads the ledger, and if any
correction-recurrence decision changed since it started (for example, you ratified a
proposal meanwhile), it refuses with `LEARN_LEDGER_CHANGED` and writes nothing. Run it again.
Lines from other producers are kept exactly as they are at that moment. The review queue is
written before the ledger.

## Privacy

- Every transcript string is scrubbed (tokens, keys, `name = secret` assignments, emails, home
  directories) as it is read, before any model call. The same scrub protects the dream run.
- The clustering call sees only the generalized rules. The judge sees the rule and your rule
  file, scrubbed.
- The ledger cites Thread locators (`claude-code:<session>` and a message id), with an excerpt
  of at most 200 bytes of scrubbed text. It never holds a transcript.
- The ledger and review queue live under `.kontourai/`, which stays untracked.

## Measuring it on your own history

`kits/knowledge/learn/evaluate.js` measures the classifier against turns you labelled
yourself. It is not run in CI, and your labels never belong in a repository.

```bash
node kits/knowledge/learn/evaluate.js --labels ~/private/labels.jsonl --write-predictions ~/private/predictions.jsonl
node kits/knowledge/learn/evaluate.js --labels ~/private/labels.jsonl --predictions ~/private/predictions.jsonl   # re-score, no model call
```

Each label line is
`{"thread_id":"claude-code:<session>","message_id":"<id>","label":"correction|nudge|frustration|none","general":true}`,
the same locator a proposal cites. The harness reports precision, recall and F1 for "counts as a
correction" (a general correction, nudge or frustration), the confusion by kind, and every
labelled turn it could not find. A labelled human turn that the origin filter dropped shows up
in that list, so it also measures the filter.

## Limitations

- **Prompts sent through an SDK or IDE host are not counted.** Ferry reports a prompt submitted
  through the Claude Code SDK (`promptSource=sdk`) or a Codex IDE session
  (`session_meta.source=vscode`) as `unknown`, because delegated agent briefs arrive the same
  way. If you work mostly through such a host, the loop sees few or no human turns. The report
  counts `unknown` origins by Ferry's evidence so you can see this. The fix belongs upstream: a
  host that records who typed a prompt.
- **The model is the judge.** Classification, theme grouping and the conflict check are model
  judgements with the model's biases. An ambiguous turn may be classified either way, two
  themes may merge or split differently on another model, and a conflict judgement is a
  reading, not a proof. Every proposal cites the messages it came from so you can check.
- **It finds workflow preferences, not postmortem lessons.** Rules written after a review or
  incident usually come from one costly event, not a repeated correction, so this loop recalls
  few of them. On a real corpus it found few of the rules already written, but found new
  workflow preferences, for example "act on your own recommendation instead of stopping to
  ask" and "fetch latest main before starting".
- **It needs weeks of history.** Recurrence across sessions takes time to show, and measuring
  a ratified proposal needs at least 14 days after ratification inside the scanned window.
- **Each run classifies the whole window again.** There is no classification cache, so a
  wider `--since` costs proportionally more model calls. `--dry-run` reports the batch count
  first.
- **Review is a file and a script.** The review items are Survey `ReviewItem`s, but they are
  not yet served through `flow-agents kit review`; decisions are recorded with
  `learning-review-decide.sh`.
- **Effect statistics are coarse.** The tolerance band and the 3-expected minimum are fixed
  heuristics. Rates are per week over the whole period, so a burst and a steady trickle look
  alike.
- **Theme lineage depends on the model.** A split is followed only when the clustering model
  names the parent theme. A split it does not name starts a new theme with no history.
- **Themes in non-Latin scripts get opaque ids** (`theme-<hash>`). They are stable, but not
  readable.
- **Removed worktrees outside the repository's paths are not attributed** (see Which sessions
  count).
