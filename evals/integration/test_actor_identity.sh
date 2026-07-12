#!/usr/bin/env bash
# test_actor_identity.sh - unit-style eval for the shared actor-identity resolver
# (scripts/hooks/lib/actor-identity.js). Written against the frozen interface documented
# in .kontourai/flow-agents/kontourai-flow-agents-287/kontourai-flow-agents-287--plan-work.md
# Wave 1 Task 1.1 (detectRuntime/runtimeSessionId/ancestorActorSeed/sanitizeSegment/
# serializeActor/resolveActor).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE="$ROOT/scripts/hooks/lib/actor-identity.js"

errors=0

_pass() { echo "  ✓ $1"; }
_fail() { echo "  ✗ $1"; errors=$((errors + 1)); }

if [[ ! -f "$MODULE" ]]; then
  echo "actor identity eval skipped: $MODULE does not exist yet." >&2
  exit 1
fi

# 1. serializeActor never contains "::" or a raw ":" inside any single segment, even given
#    adversarial input (session_id containing ":", "/", spaces, unicode).
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { serializeActor } = require(path);
const out = serializeActor({
  runtime: "claude-code",
  session_id: "sess:with/slash space:moreéé",
  host: "ho:st/name",
  human: "hu man:name",
});
if (typeof out !== "string" || out.length === 0) {
  throw new Error(`serializeActor did not return a non-empty string: ${JSON.stringify(out)}`);
}
if (out.includes("::")) {
  throw new Error(`serializeActor output contains "::": ${JSON.stringify(out)}`);
}
if (!/^[A-Za-z0-9_.:-]+$/.test(out)) {
  throw new Error(`serializeActor output contains disallowed characters: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "serializeActor sanitizes adversarial segments (no :: and no raw : inside a segment)"
else
  _fail "serializeActor did not sanitize adversarial input safely"
fi

# 2. resolveActor({FLOW_AGENTS_ACTOR: "my-actor"}) returns {actor: "my-actor", ...} — explicit
#    override always wins, even if a runtime var is also present in the injected env.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR: "my-actor", CLAUDE_CODE_SESSION_ID: "sess-should-be-ignored" });
if (!out || out.actor !== "my-actor") {
  throw new Error(`resolveActor did not honor explicit FLOW_AGENTS_ACTOR override: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor honors explicit FLOW_AGENTS_ACTOR override even with a runtime var present"
else
  _fail "resolveActor did not honor explicit FLOW_AGENTS_ACTOR override"
fi

# 3. resolveActor({FLOW_AGENTS_ACTOR: "local"}) does NOT honor the literal "local" override
#    (falls through to runtime/ancestry resolution) — proves "local" can never round-trip back
#    in via the override seam.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR: "local" });
if (!out || typeof out.actor !== "string" || out.actor.trim().toLowerCase() === "local") {
  throw new Error(`resolveActor honored the literal "local" override: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor never honors the literal \"local\" override"
else
  _fail "resolveActor incorrectly honored the literal \"local\" override"
fi

# 4. resolveActor({CLAUDE_CODE_SESSION_ID: "sess-a"}) vs resolveActor({CLAUDE_CODE_SESSION_ID:
#    "sess-b"}) (host held constant) produce two different serialized actors.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const a = resolveActor({ CLAUDE_CODE_SESSION_ID: "sess-a" });
const b = resolveActor({ CLAUDE_CODE_SESSION_ID: "sess-b" });
if (!a || !b || !a.actor || !b.actor) {
  throw new Error(`resolveActor returned an empty actor for a runtime-native session id: a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
}
if (a.actor === b.actor) {
  throw new Error(`resolveActor produced the same actor for two distinct session ids: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}
NODE
then
  _pass "resolveActor produces distinct actors for distinct runtime session ids"
else
  _fail "resolveActor did not distinguish between distinct runtime session ids"
fi

# 5. Stability test: call resolveActor({}) (real ambient env, no runtime var, forcing the
#    ancestry path) twice in the same process with a real setTimeout gap of several seconds
#    between calls; assert byte-identical output both times.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const first = resolveActor({});
setTimeout(() => {
  const second = resolveActor({});
  const a = JSON.stringify(first);
  const b = JSON.stringify(second);
  if (a !== b) {
    console.error(`resolveActor({}) was not stable across a delay: first=${a} second=${b}`);
    process.exit(1);
  }
  process.exit(0);
}, 3000);
NODE
then
  _pass "resolveActor({}) is byte-identical across a several-second real-time gap (ancestry stability)"
else
  _fail "resolveActor({}) was not stable across a several-second real-time gap"
fi

# 6. resolveActor({FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED: "1", NODE_ENV: "test"}) returns
#    {actor: "", source: "test-forced-unresolved"} — the hatch requires BOTH the force-unresolved
#    var AND NODE_ENV=test (F4, #287 fix iteration 1); the var alone (no NODE_ENV=test) must NOT
#    trip the hatch, proving it cannot be tripped by an accidental/malicious env var outside a
#    real test harness.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED: "1", NODE_ENV: "test" });
if (!out || out.actor !== "" || out.source !== "test-forced-unresolved") {
  throw new Error(`resolveActor did not honor the test-forced-unresolved escape hatch: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor honors FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED escape hatch when NODE_ENV=test is also set"
else
  _fail "resolveActor did not honor FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED escape hatch with NODE_ENV=test"
fi

# 6b (F4 negative). The hatch var alone, WITHOUT NODE_ENV=test, must NOT force an unresolved actor
# — proves the gate is a real AND, not an OR.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR_TEST_FORCE_UNRESOLVED: "1" });
if (out && out.source === "test-forced-unresolved") {
  throw new Error(`resolveActor honored the test-forced-unresolved escape hatch without NODE_ENV=test: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor does NOT honor the escape hatch when NODE_ENV=test is missing (F4 gate is AND, not OR)"
else
  _fail "resolveActor incorrectly honored the escape hatch without NODE_ENV=test"
fi

# 7 (T1, F2). Adversarial FLOW_AGENTS_ACTOR override — containing "::", a raw newline, and
# exceeding 64 chars — resolves to a sanitized, capped actor: no ":" anywhere, length <= 64.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const adversarial = "a::b\nc" + "x".repeat(100);
const out = resolveActor({ FLOW_AGENTS_ACTOR: adversarial });
if (!out || typeof out.actor !== "string" || !out.actor) {
  throw new Error(`resolveActor returned no actor for adversarial override: ${JSON.stringify(out)}`);
}
if (out.actor.includes(":")) {
  throw new Error(`resolveActor did not strip ":" from adversarial override: ${JSON.stringify(out)}`);
}
if (out.actor.includes("\n")) {
  throw new Error(`resolveActor did not strip newline from adversarial override: ${JSON.stringify(out)}`);
}
if (out.actor.length > 64) {
  throw new Error(`resolveActor did not cap adversarial override at 64 chars: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor sanitizes and caps an adversarial FLOW_AGENTS_ACTOR override (:: / newline / >64 chars)"
else
  _fail "resolveActor did not sanitize/cap an adversarial FLOW_AGENTS_ACTOR override"
fi

# 8 (T1, F3). Rejected FLOW_AGENTS_ACTOR=local (case-insensitive) emits exactly one stderr warning
# line naming FLOW_AGENTS_ACTOR — never on stdout, never a thrown exception.
TMPDIR_EVAL_STDERR_CAPTURE="$(mktemp)"
if node - "$MODULE" >"$TMPDIR_EVAL_STDERR_CAPTURE.out" 2>"$TMPDIR_EVAL_STDERR_CAPTURE.err" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR: "LOCAL" });
process.stdout.write(JSON.stringify(out));
NODE
then
  if grep -qF "FLOW_AGENTS_ACTOR=local" "$TMPDIR_EVAL_STDERR_CAPTURE.err" \
    && ! grep -qF "FLOW_AGENTS_ACTOR=local" "$TMPDIR_EVAL_STDERR_CAPTURE.out"; then
    _pass "rejected FLOW_AGENTS_ACTOR=local (case-insensitive) emits one stderr warning, never on stdout"
  else
    _fail "rejected FLOW_AGENTS_ACTOR=local warning missing from stderr or leaked onto stdout: out=$(cat "$TMPDIR_EVAL_STDERR_CAPTURE.out") err=$(cat "$TMPDIR_EVAL_STDERR_CAPTURE.err")"
  fi
else
  _fail "resolveActor threw for a rejected FLOW_AGENTS_ACTOR=local override (must never throw)"
fi
rm -f "$TMPDIR_EVAL_STDERR_CAPTURE.out" "$TMPDIR_EVAL_STDERR_CAPTURE.err"

# 9 (T4, F7). resolveActor({FLOW_AGENTS_ACTOR: ":::"}) — a value that strips to empty under the
# allowed [A-Za-z0-9_.-] charset — must NOT adopt the shared "unknown" sentinel: it falls through
# to derivation (source != "explicit-override", actor != "unknown") and emits one stderr warning,
# never stdout, never a thrown exception.
TMPDIR_EVAL_STRIPEMPTY_CAPTURE="$(mktemp)"
if node - "$MODULE" >"$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.out" 2>"$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.err" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR: ":::" });
process.stdout.write(JSON.stringify(out));
NODE
then
  STRIPEMPTY_OUT="$(cat "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.out")"
  if echo "$STRIPEMPTY_OUT" | node -e 'const out = JSON.parse(require("fs").readFileSync(0, "utf8")); if (!out || out.actor === "unknown" || out.source === "explicit-override") process.exit(1);'     && grep -qF "FLOW_AGENTS_ACTOR" "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.err"     && ! grep -qF "FLOW_AGENTS_ACTOR" "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.out"; then
    _pass "resolveActor({FLOW_AGENTS_ACTOR: ':::'}) falls through to a derived actor (not 'unknown', not explicit-override) with a stderr warning"
  else
    _fail "resolveActor did not fall through correctly for a strip-to-empty override: out=$STRIPEMPTY_OUT err=$(cat "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.err")"
  fi
else
  _fail "resolveActor threw for a strip-to-empty FLOW_AGENTS_ACTOR override (must never throw)"
fi
rm -f "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.out" "$TMPDIR_EVAL_STRIPEMPTY_CAPTURE.err"

# 10 (T4, F7). resolveActor({FLOW_AGENTS_ACTOR: "unknown"}) — a deliberate literal "unknown" — is
# honored as-is via the explicit-override path (proves the sentinel itself is not blacklisted;
# only a strip-to-empty value is rejected).
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActor } = require(path);
const out = resolveActor({ FLOW_AGENTS_ACTOR: "unknown" });
if (!out || out.actor !== "unknown" || out.source !== "explicit-override") {
  throw new Error(`resolveActor did not honor a deliberate literal "unknown" override: ${JSON.stringify(out)}`);
}
NODE
then
  _pass "resolveActor honors a deliberate literal FLOW_AGENTS_ACTOR=unknown override (sentinel itself is not blacklisted)"
else
  _fail "resolveActor did not honor a deliberate literal FLOW_AGENTS_ACTOR=unknown override"
fi

# 11 (#554). CODEX_THREAD_ID is the preferred native Codex signal. Its raw value must never
# become durable actor text: it is transformed into a stable, domain-separated 96-bit token.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { detectRuntime, runtimeSessionId, resolveActor, resolveActorIdentity, serializeActor } = require(path);
const rawA = "thread:private/value\nwith-control";
const rawB = "thread:other-private-value";
const envA = { CODEX_THREAD_ID: rawA, CODEX_SESSION_ID: "legacy-must-lose" };
if (detectRuntime(envA) !== "codex") throw new Error("CODEX_THREAD_ID did not detect codex");
if (runtimeSessionId(envA) !== rawA) throw new Error("CODEX_THREAD_ID did not win ordered priority");
if (runtimeSessionId({ CODEX_SESSION_ID: "legacy-ok" }) !== "legacy-ok") throw new Error("legacy CODEX_SESSION_ID stopped working");
const first = resolveActor(envA);
const repeat = resolveActor(envA);
const distinct = resolveActor({ CODEX_THREAD_ID: rawB });
const identity = resolveActorIdentity(envA);
if (JSON.stringify(first) !== JSON.stringify(repeat)) throw new Error("same thread was unstable");
if (first.actor === distinct.actor) throw new Error("distinct threads collided");
if (first.source !== "runtime-session-id:codex") throw new Error(`wrong source: ${JSON.stringify(first)}`);
if (!identity.actorStruct || identity.actor !== serializeActor(identity.actorStruct)) throw new Error("canonical actor struct/key diverged");
if (identity.actorStruct.session_id.includes("private")) throw new Error("raw id leaked through canonical actor struct");
if (!/^codex:thread-[a-f0-9]{24}:[A-Za-z0-9_.-]+$/.test(first.actor)) throw new Error(`unsafe actor shape: ${JSON.stringify(first)}`);
if (first.actor.includes(rawA) || first.actor.includes("private") || first.actor.includes("legacy-must-lose")) throw new Error("raw native id leaked");
NODE
then
  _pass "CODEX_THREAD_ID yields a stable, distinct, privacy-safe Codex actor and wins over the legacy signal"
else
  _fail "CODEX_THREAD_ID native identity contract failed"
fi

# 12 (#554). Ancestry is explicitly classified in its display string but remains unstable by source.
if node - "$MODULE" <<'NODE'
const path = process.argv[2];
const { resolveActorIdentity, serializeActor } = require(path);
const out = resolveActorIdentity({});
if (!out || out.source !== "process-ancestry") throw new Error(`wrong fallback source: ${JSON.stringify(out)}`);
if (!out.actor.startsWith("process-ancestry:anc-")) throw new Error(`fallback remains misleading: ${JSON.stringify(out)}`);
if (out.actor.startsWith("unknown:anc-")) throw new Error(`legacy fallback still emitted: ${JSON.stringify(out)}`);
if (!out.actorStruct || out.actorStruct.runtime !== "process-ancestry" || out.actor !== serializeActor(out.actorStruct)) throw new Error(`fallback struct/key diverged: ${JSON.stringify(out)}`);
NODE
then
  _pass "ancestry fallback is explicitly labeled process-ancestry without changing its source classification"
else
  _fail "ancestry fallback label/source contract failed"
fi

# 13 (#554). Historical actor values remain opaque and readable; no alias/schema rewrite is needed.
if node - "$ROOT/scripts/hooks/lib/liveness-read.js" <<'NODE'
const { freshHolders } = require(process.argv[2]);
const legacy = "unknown:anc-eabf4cb9ef38:old-host";
const at = "2026-07-11T12:00:00.000Z";
const events = [{ type: "claim", subjectId: "legacy-work", actor: legacy, at, ttlSeconds: 1800 }];
const foreign = freshHolders(events, "legacy-work", "new-self", Date.parse(at) + 1000);
const self = freshHolders(events, "legacy-work", legacy, Date.parse(at) + 1000);
if (foreign.length !== 1 || foreign[0].actor !== legacy) throw new Error(`legacy record unreadable: ${JSON.stringify(foreign)}`);
if (self.length !== 0) throw new Error(`legacy self-filter failed: ${JSON.stringify(self)}`);
if (events[0].actor !== legacy || Object.prototype.hasOwnProperty.call(events[0], "actor_key")) throw new Error("legacy record was mutated");
NODE
then
  _pass "legacy unknown:anc-* records remain readable, self-filterable, and unmodified"
else
  _fail "legacy unknown:anc-* compatibility failed"
fi

if [[ "$errors" -eq 0 ]]; then
  echo "Actor identity resolver integration passed."
  exit 0
fi

echo "Actor identity resolver integration failed: $errors issue(s)."
exit 1
