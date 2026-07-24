import {
  createRunCorrelationEnvelope,
  runtimeCorrelationIdentityDeclaration,
  type RunCorrelationEnvelope,
  type RunCorrelationIdentity,
  type RuntimeCorrelationIdentitySupport,
} from "./run-correlation.js";

type BuilderCorrelationActor = {
  runtime: string;
  session_id: string;
};

export type CreateBuilderRunCorrelationInput = {
  runId: string;
  workItemRef: string;
  actor: BuilderCorrelationActor;
  actorKey: string;
};

function unavailableIdentity(reason: string): RunCorrelationIdentity {
  return { status: "unavailable", reason };
}

function identityFromRuntimeSupport(
  support: RuntimeCorrelationIdentitySupport,
  unavailableReason: string,
): RunCorrelationIdentity {
  if (support.status === "supported" || support.status === "partial") {
    return unavailableIdentity(unavailableReason);
  }
  return { status: support.status, reason: support.reason };
}

export function createBuilderRunCorrelation(
  input: CreateBuilderRunCorrelationInput,
): RunCorrelationEnvelope {
  const runtime = input.actor.runtime.trim();
  const runtimeSessionId = input.actor.session_id.trim();
  const declaration = runtimeCorrelationIdentityDeclaration(runtime);
  const runtimeSession = declaration.runtime_session.status === "supported"
      || declaration.runtime_session.status === "partial"
    ? { status: "present" as const, value: runtimeSessionId }
    : identityFromRuntimeSupport(
        declaration.runtime_session,
        "the runtime did not provide a session identity at Builder start",
      );

  return createRunCorrelationEnvelope({
    identities: {
      runtime_session: runtimeSession,
      runtime_turn: identityFromRuntimeSupport(
        declaration.runtime_turn,
        "a runtime turn identity is not established at Builder run start",
      ),
      flow_run: { status: "present", value: input.runId },
      flow_step: unavailableIdentity("the immutable run envelope spans changing Flow steps"),
      work_item: { status: "present", value: input.workItemRef },
      agent: { status: "present", value: input.actorKey },
      delegation_trace: identityFromRuntimeSupport(
        declaration.delegation_trace,
        "a delegation trace is not established at Builder run start",
      ),
      delegation_span: identityFromRuntimeSupport(
        declaration.delegation_span,
        "a delegation span is not established at Builder run start",
      ),
      terminal_record: unavailableIdentity("the terminal record does not exist at Builder run start"),
    },
  });
}
