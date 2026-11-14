/**
 * #1648: bind the WORKER's runtime session to an orchestrator-acquired assignment.
 *
 * An orchestrator that claims an assignment from its own server process records no
 * `runtime_session_ref` (it is not the holder's runtime), so the #1092 runtime-derived reviewer
 * check cannot tell the implementer from a reviewer and refuses every passing critique. The fix
 * keeps #1092's guarantee: the session is recorded by the HOLDER's runtime, on its first observed
 * activity, through the same same-actor re-claim `flow-agents assignment-provider claim` performs.
 *
 * There is deliberately no parameter that carries a session reference. The reference comes only
 * from `resolveRuntimeSessionForHolder`, which reads the calling process's own runtime
 * environment and refuses unless that process resolves to the assignment's holder actor and has a
 * runtime-derived session. An orchestrator therefore cannot bind a session on a worker's behalf by
 * passing one in. (As #1644 records, runtime-derived identity is not authentication: a process
 * that forges its own session environment is out of scope here exactly as it is for #1092.)
 *
 * Decision record: docs/decisions/observe-mode.md (Integration: orchestrator-acquired claims).
 */
import path from "node:path";
import { performLocalClaim, readLocalRecord } from "./assignment-local-store.js";
import { resolveRuntimeSessionForHolder } from "../cli/assignment-provider.js";

export type HolderSessionBinding =
  | { status: "bound"; ref: string }
  | { status: "already-bound"; ref: string }
  | { status: "no-assignment" | "not-holder" | "no-runtime-session"; ref?: undefined };

export const HOLDER_BINDING_REASON = "holder runtime session bound on first observed activity (#1648)";

/**
 * The recovery step named whenever a passing review is refused for a missing holder session. With
 * a known assignment it is the exact command; otherwise its arguments are placeholders.
 */
export function holderBindingRecovery(where?: { artifactRoot: string; slug: string; branch?: string }): string {
  const claim = `flow-agents assignment-provider claim --artifact-root ${where ? JSON.stringify(where.artifactRoot) : "<artifact-root>"} --subject-id ${where?.slug ?? "<slug>"} --artifact-dir ${where?.slug ?? "<slug>"} --branch ${where?.branch ?? "<branch>"}`;
  return "Recovery: from the WORKER's own runtime session (the holder, never the orchestrator), with the same actor, run " +
    `\`${claim}\`. In an observe run the worker's first command under Flow Agents hooks, its Stop, or \`flow-agents observe verify\` ` +
    "does this automatically. Then the separate reviewer records `workflow critique` again.";
}
export const HOLDER_BINDING_RECOVERY = holderBindingRecovery();

export function bindHolderRuntimeSession(sessionDir: string): HolderSessionBinding {
  const artifactRoot = path.dirname(sessionDir);
  const slug = path.basename(sessionDir);
  const record = readLocalRecord(artifactRoot, slug);
  if (!record || record.status !== "claimed" || typeof record.actor_key !== "string" || !record.actor_key) return { status: "no-assignment" };
  const runtimeSession = resolveRuntimeSessionForHolder(record.actor_key);
  // Only a HOST runtime session (a Claude Code, Codex, ... session id) binds the worker. Process
  // ancestry is runtime-derived but identifies whatever process happened to run the hook (an
  // orchestrator's own process, for example), so it never counts as the holder's binding.
  if (!runtimeSession || !runtimeSession.source.startsWith("runtime-session-id:")) {
    return { status: "no-runtime-session" };
  }
  const held = Array.isArray(record.runtime_session_refs) ? record.runtime_session_refs : record.runtime_session_ref ? [record.runtime_session_ref] : [];
  if (held.includes(runtimeSession.ref) && record.runtime_session_ref) return { status: "already-bound", ref: runtimeSession.ref };
  performLocalClaim(artifactRoot, slug, record.actor, {
    ttlSeconds: record.ttl_seconds,
    branch: record.branch,
    artifactDir: record.artifact_dir,
    reason: HOLDER_BINDING_REASON,
    actorKey: record.actor_key,
    ...(record.work_item_ref ? { workItemRef: record.work_item_ref } : {}),
    runtimeSession,
  });
  return { status: "bound", ref: runtimeSession.ref };
}
