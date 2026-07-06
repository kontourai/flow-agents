'use strict';
/**
 * runnable-command.js — shared pure-CJS runnable-command-text heuristic (#412)
 *
 * Zero external dependencies (only string ops). Consumed by:
 *   - scripts/hooks/stop-goal-fit.js     (CJS, direct require)
 *   - build/src/cli/workflow-sidecar.js  (ESM compiled, via createRequire)
 *
 * Extracted verbatim (no logic change) from stop-goal-fit.js's former inline
 * `isRunnableCommandText`, so the heuristic has exactly one source of truth
 * instead of drifting between the hook (Stop-time backstop) and the sidecar
 * (record-time rejection).
 *
 * Exports:
 *   isRunnableCommandText(text) → boolean
 *   isAmbiguousAbsenceCommand(text) → boolean
 */

// WS8 (AC10b): a kind:"command" evidence ref's excerpt/command must be a literally runnable
// shell command, not a prose description of a manual verification step. This heuristic
// rejects prose so the goal-fit backstop never spawns `bash -lc "<a sentence>"` and
// misreports the resulting shell error as a caught false-completion. Pairs with the rule
// stated in context/contracts/planning-contract.md (AC11).
//
// #362 (Wave 3 coherence fix): a leading `!` negation (optionally followed by whitespace) is
// stripped before evaluation, mirroring isAmbiguousAbsenceCommand's own negation handling
// (runnable-command.js's OTHER export, above/below) -- a negated runnable command (e.g.
// `! grep -r foo src/`, the exact self-asserting rewrite this module's ambiguous-absence
// guidance recommends) is itself still a literally runnable shell command, not prose. Without
// this, the ambiguous-absence advisory's own suggested remediation would be rejected by this
// function's fatal runnability guard -- a self-defeating loop. Only a BARE leading `!` is
// stripped (a single strip, not recursive); the remainder is evaluated by the existing checks
// unchanged, so a genuinely non-command sentence that happens to start with `!` (e.g.
// `! a prose sentence. It fails.`) still fails the sentence-like-prose check below and is
// rejected, fail-closed exactly as before.
function isRunnableCommandText(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return false;
  const unnegated = s.replace(/^!\s*/, '');
  if (!unnegated) return false;
  // Sentence-like prose (a . ! or ? followed by more words) is not a single command.
  if (/[.!?]\s+\S/.test(unnegated)) return false;
  const first = unnegated.split(/\s+/)[0] || '';
  // WS8 (AC10b, iteration 2): the first-token allowlist is broadened to the common
  // real-world verify binaries a project's runnable evidence names (git, tsc, eslint,
  // python/python3, docker, curl, jq, diff, grep, test) so honest command evidence is not
  // misclassified as prose. Still fail-closed for genuinely non-command prose: a bare
  // sentence whose first token is none of these (and carries no path prefix or shell
  // metacharacter) is rejected rather than executed.
  const knownBinary = /^(npm|npx|pnpm|yarn|node|bash|sh|zsh|make|just|task|cargo|go|pytest|tox|deno|bun|ruby|rake|mvn|gradle|dotnet|swift|flutter|dart|git|tsc|eslint|python|python3|docker|curl|jq|diff|grep|test)$/.test(first)
    || first.startsWith('./') || first.startsWith('/') || first.includes('/');
  const hasShellMeta = /[|&;<>()$`]/.test(unnegated);
  return knownBinary || hasShellMeta;
}

// #362: a BARE (non-negated, non-self-asserting) `grep`/`diff` invocation is exit-code
// AMBIGUOUS for its two most common uses — a "the thing is absent" check (author intends
// exit 1 = PASS) and a "the thing is present" check (author intends exit 1 = FAIL) look
// byte-identical to any downstream consumer that only sees the exit code. This heuristic
// recognizes that SHAPE (narrowly: grep/diff only, per the plan's explicit two-binary
// carve-out — see plan body "#362 root cause") so callers can classify a bare exit-1
// result as ambiguous/NOT_VERIFIED instead of guessing pass or fail.
//
// A command is NOT ambiguous (i.e. already self-asserting, exit code already encodes the
// author's intent) when ANY of:
//   - it is negated with a leading `!` (`! grep ...` — negation flips 0/1 into the
//     intended fail/pass, so exit 0 unambiguously means "pattern is present/absent" per
//     the author's own assertion)
//   - it is part of a `||`/`&&` boolean chain (`grep ... || true`, `grep ... && echo ok`)
//     — the chain itself already asserts what a given branch outcome means
//   - it is piped into a count-assertion (`grep -c ... | grep -qx 0`, `grep ... | wc -l`
//     style) — the author is asserting on a MATCH COUNT, not on grep's own raw exit code
//   - its first real command token (after stripping `bash -lc '...'` wrapping and any
//     leading `KEY=value` env assignments) is not exactly `grep` or `diff`
//
// FROZEN, narrowly-scoped by design (plan item 4): exactly two binaries, one ambiguous
// exit code each (1). Do NOT grow this into a general per-binary exit-code table — that
// is explicitly rejected in the plan (unreliable for pipelines/subshells/compound
// commands). This function classifies EXIT-CODE ambiguity only; it has no opinion on
// (and does not touch) the recorded command's regex dialect/flags (BRE vs ERE, -E/-P/-G,
// etc.) — that is a SEPARATE invariant, enforced at replay time by
// `resolveTrustedCommand`/`runBackstop` (scripts/hooks/stop-goal-fit.js, search
// "DIALECT-PRESERVATION INVARIANT"): the recorded command string is replayed verbatim on
// every backstop re-run path so a `grep -E '(foo|bar)'`-style ERE construct is never
// silently reinterpreted as BRE.
function isAmbiguousAbsenceCommand(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (!s) return false;

  // Unwrap a `bash -lc '<command>'` / `sh -c "<command>"` style wrapper so the real
  // command is inspected, not the shell launcher. Only a single level of unwrapping is
  // attempted — this stays a narrow heuristic, not a shell parser.
  let inner = s;
  const wrapped = inner.match(/^(?:bash|sh|zsh)\s+-\S*c\s+(['"])([\s\S]*)\1\s*$/);
  if (wrapped) inner = wrapped[2].trim();

  if (!inner) return false;

  // Negation anywhere at the start of the (unwrapped) command already asserts intent.
  if (/^!\s*/.test(inner)) return false;

  // A `||`/`&&` boolean chain already asserts what a given exit code means for the
  // overall command (e.g. `grep ... || true`, `grep ... && echo found`).
  if (/\|\|/.test(inner) || /&&/.test(inner)) return false;

  // Strip leading `KEY=value` environment assignments (e.g. `FOO=bar grep ...`) to find
  // the first REAL command token.
  let rest = inner;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+(\S[\s\S]*)$/);
    if (!m) break;
    rest = m[1].trim();
  }

  // A pipe (any `|`, since `||` was already excluded above) into a count-assertion
  // (`grep -c ... | grep -qx 0`, `... | wc -l`) already asserts intent on the MATCH
  // COUNT, not on grep/diff's own raw exit code — so ANY pipe makes this "not a bare
  // invocation" for this narrow heuristic: a bare absence-style grep/diff is by
  // definition not piped anywhere.
  if (rest.includes('|')) return false;

  const first = rest.trim().split(/\s+/)[0] || '';
  return first === 'grep' || first === 'diff';
}

module.exports = { isRunnableCommandText, isAmbiguousAbsenceCommand };
