#!/usr/bin/env node
/**
 * Subject Binding Hook
 *
 * PreToolUse. Intercepts the FIRST WRITE — the moment work becomes real — when no Flow Agents
 * subject is bound for this actor, and names the binding command. Reads, research, and
 * conversation are untouched; the gate is on mutation.
 *
 * WHY THIS EVENT (#1099). The kit already carries the enforcement that would have caught
 * four duplicated pieces of work in one night: `workflow-steering`'s every-turn SUPERSEDED notice,
 * which fires once another actor holds a fresh liveness claim on the caller's subject. It was live
 * the whole time and had nothing to key on, because it needs a subject and a subject only exists
 * after someone chooses to run `ensure-session`. Nobody did. `config-protection`, `quality-gate`,
 * `evidence-capture` and telemetry all fired normally throughout — this was the one policy with no
 * subject.
 *
 * The tempting fix is to classify the user's prompt ("is this turn builder work?") and offer to
 * create the session. That is a guess about intent, and a gate that guesses wrong on ordinary turns
 * gets dismissed reflexively, which kills it. "You are about to write a file and there is nothing
 * to point at" is not a guess — it is a fact, statable plainly, and it lands at the earliest moment
 * the collision window opens: duplication happens in the hours between two lanes starting and
 * either one publishing, so binding late leaves the liveness signal absent for exactly the window
 * it exists to cover.
 *
 * ADVISORY BY DEFAULT (`FLOW_AGENTS_SUBJECT_BINDING=warn`, engine default). A spurious block in
 * front of every file write in every repo installing the kit would teach agents to route around
 * the mechanism — strictly worse than the missed bind it prevents, which costs tokens rather than
 * correctness. `block` is opt-in for an operator who has decided their repo means it. Repeats are
 * cooldown-limited per actor so a declined prompt does not become per-write noise.
 *
 * ALSO: `gh issue create` gets the duplicate-check reminder. Because the subject id is DERIVED from
 * the backlog item (scripts/hooks/lib/subject-identity.js), "does an item for this already exist?"
 * and "is another lane live on it?" are one query against one key — so the two reminders belong in
 * one hook rather than two mechanisms over two vocabularies.
 *
 * Exit codes: 0 = allow (guidance appended to stdout), 2 = block (mode=block only)
 */

'use strict';

const path = require('path');
const {
  resolveSubjectBindingMode,
  resolveNoticeCooldownSeconds,
  boundSubject,
  classifyMutation,
  backlogCreateCommand,
  noticeCooldownElapsed,
  recordNotice,
  installProvenance,
} = require('./lib/subject-binding');
const { resolveActor } = require('./lib/actor-identity');
const { readOriginRepo } = require('./lib/subject-identity');
const { resolveSharedRepoRoot } = require('./lib/local-artifact-paths');

const MAX_STDIN = 1024 * 1024;

/**
 * Display-sanitize any string that reaches agent-facing output. Actor ids and last-seen stamps
 * come off the shared multi-writer liveness stream, which any process can append to — the same
 * untrusted-display-input rule workflow-steering.js's safeStateText and workflow-sidecar.ts's
 * stripControlCharsForDisplay apply (#287/#293 injection class). Whitespace-collapse first so an
 * embedded newline becomes a joining space, then strip C0/DEL/C1.
 */
function safeText(value, maxLength = 200) {
  const collapsed = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  const text = collapsed.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

/**
 * The one line that tells the operator whether this hook is the published package or a file
 * synced in by hand for a fast iteration loop. Empty when the answer is uninteresting.
 */
function provenanceLine() {
  const { installed, locallyModified } = installProvenance(__filename);
  if (!installed || !locallyModified) return '';
  return 'PROVENANCE: this hook is running from a LOCALLY-SYNCED file in the global install, not the published package — it is invisible to every other machine and will be wiped by the next `npm i -g`.';
}

/**
 * Compose the first-write binding notice.
 *
 * @param {{target: string, actor: string, repo: string|null, mode: string}} context
 * @returns {string}
 */
function bindingNotice(context) {
  const lines = [
    `[SUBJECT BINDING] About to modify ${safeText(context.target) || 'a repository file'} and no Flow Agents subject is bound for actor ${safeText(context.actor, 80)}.`,
    'Every code change is meant to correlate to a backlog item and carry a trust bundle. With no subject bound, nothing records what this change is for, and no other lane can see you are on it. flow-agents#1099: four pieces of work duplicated in one night, zero subjects bound.',
    `Bind it before writing: flow-agents workflow start --flow builder.build --work-item ${safeText(context.repo, 80) || '<owner>/<repo>'}#<issue> --assignment-provider <kind>`,
    'The subject id is DERIVED from the backlog item (owner/repo#123 -> owner-repo-123), never chosen — that is what makes two lanes on one item collide-detect, and it makes "is anyone else on this?" and "has this already been filed?" the same lookup.',
    "No backlog item for this change? Get the owner's explicit confirmation, or open a local subject: flow-agents workflow start --flow builder.shape --task-slug <slug>.",
  ];
  if (context.mode === 'warn') {
    lines.push('Advisory (FLOW_AGENTS_SUBJECT_BINDING=warn): proceeding unbound is a choice you are making, not a default.');
  }
  const provenance = provenanceLine();
  if (provenance) lines.push(provenance);
  return lines.join('\n');
}

/**
 * Compose the pre-file duplicate-check reminder.
 *
 * @param {string|null} repo
 * @returns {string}
 */
function backlogDuplicateNotice(repo) {
  return [
    '[BACKLOG DUPLICATE CHECK] About to file a new backlog item — search the backlog first.',
    `  gh issue list --repo ${safeText(repo, 80) || '<owner>/<repo>'} --state all --search "<the words you would put in the title>" --limit 20`,
    'Parallel lanes filed ~20 items in one night with no such check and produced a near-duplicate pair caught only by a manual sweep (flow-agents#1099). If an item already exists, work it instead: its identifier IS the subject id, so one lookup answers both "already filed?" and "already claimed?".',
  ].join('\n');
}

/**
 * @param {string} rawInput
 * @returns {{exitCode: number, stderr?: string, stdout?: string}}
 */
function run(rawInput) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return { exitCode: 0 };
  }
  try {
    const mode = resolveSubjectBindingMode(process.env);
    if (mode === 'off') return { exitCode: 0 };

    const cwd = input.cwd || process.cwd();
    const repoRoot = resolveSharedRepoRoot(cwd) || cwd;

    const backlogCreate = backlogCreateCommand(input);
    if (backlogCreate) {
      const repo = backlogCreate.repo || readOriginRepo(repoRoot, process.env);
      // Always advisory: refusing to let an agent file an issue is a far worse failure than a
      // duplicate issue, and the search it is asking for cannot be performed inside a hook.
      return { exitCode: 0, stdout: `${rawInput}\n\n---\n${backlogDuplicateNotice(repo)}\n---` };
    }

    const mutation = classifyMutation(input);
    if (!mutation.mutating) return { exitCode: 0 };

    const actor = resolveActor(process.env).actor || 'unresolved';
    if (boundSubject(cwd, actor)) return { exitCode: 0 };

    // Unbound. In warn mode the notice is cooldown-limited per actor so it stays meaningful; in
    // block mode there is no cooldown, because a gate that refuses the first write and permits
    // the second is worse than either consistent answer.
    const nowMs = Date.now();
    const noticeId = 'unbound-first-write';
    if (mode === 'warn') {
      const cooldown = resolveNoticeCooldownSeconds(process.env);
      if (!noticeCooldownElapsed(cwd, actor, noticeId, nowMs, cooldown)) return { exitCode: 0 };
      recordNotice(cwd, actor, noticeId, nowMs);
    }

    const notice = bindingNotice({
      target: path.basename(mutation.target || ''),
      actor,
      repo: readOriginRepo(repoRoot, process.env),
      mode,
    });
    if (mode === 'block') return { exitCode: 2, stderr: notice };
    return { exitCode: 0, stdout: `${rawInput}\n\n---\n${notice}\n---` };
  } catch {
    // Fail open, always: this gate must never be the reason a session cannot make progress.
    return { exitCode: 0 };
  }
}

module.exports = { run, bindingNotice, backlogDuplicateNotice, provenanceLine, safeText };

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) raw += chunk.substring(0, MAX_STDIN - raw.length);
  });
  process.stdin.on('end', () => {
    const result = run(raw);
    if (result.stderr) process.stderr.write(`${result.stderr}\n`);
    if (result.exitCode === 2) process.exit(2);
    process.stdout.write(typeof result.stdout === 'string' ? result.stdout : raw);
  });
}
