import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { flowRunHead, loadRun } from "@kontourai/flow";
import { inspectBuilderFlowSession, withBuilderFlowProjectionCurrent } from "./builder-flow-runtime.js";
import { atomicWriteFile } from "./lib/fs.js";
import {
  orchestrateFlowMultiCursor,
  type FlowScheduleObservation,
  type OrchestrateFlowMultiCursorInput,
} from "./multi-cursor-flow-orchestrator.js";

export interface BuilderFlowScheduleEvidence {
  schemaVersion: "1.0";
  kind: "kontourai.builder.multi-cursor-schedule";
  builderRun: {
    runId: string;
    definitionId: string;
    definitionVersion: string;
    definitionDigest: string;
    runHead: string;
    currentStep: string;
  };
  schedule: FlowScheduleObservation;
}

export interface BuilderFlowScheduleArtifactRef {
  kind: "artifact";
  file: string;
  summary: string;
}

export interface OrchestrateBuilderFlowMultiCursorInput extends Omit<OrchestrateFlowMultiCursorInput, "cwd"> {
  sessionDir: string;
}

export interface BuilderFlowMultiCursorResult {
  evidence: BuilderFlowScheduleEvidence;
  evidenceRef: BuilderFlowScheduleArtifactRef;
}

function builderBinding(session: Awaited<ReturnType<typeof inspectBuilderFlowSession>>): BuilderFlowScheduleEvidence["builderRun"] {
  return {
    runId: session.run.runId,
    definitionId: session.run.definitionId,
    definitionVersion: session.run.definitionVersion,
    definitionDigest: session.run.definitionDigest,
    runHead: flowRunHead(session.run.state),
    currentStep: session.run.state.current_step,
  };
}

/**
 * Run a Builder-hosted verification plan and persist its bound, content-safe
 * schedule as an artifact for the existing `workflow evidence` interface.
 */
export async function orchestrateBuilderFlowMultiCursor(
  input: OrchestrateBuilderFlowMultiCursorInput,
): Promise<BuilderFlowMultiCursorResult> {
  return withBuilderFlowProjectionCurrent({ sessionDir: input.sessionDir }, async () => {
    const before = await inspectBuilderFlowSession({ sessionDir: input.sessionDir });
    if (input.runId === before.run.runId) throw new Error("Builder schedule run must be distinct from its binding session run");
    const plan = await loadRun(input.runId, before.projectRoot);
    if (plan.state.subject !== before.run.state.subject) {
      throw new Error("Builder schedule run subject does not match its binding session");
    }
    const { sessionDir: _sessionDir, ...scheduleInput } = input;
    const schedule = await orchestrateFlowMultiCursor({ ...scheduleInput, cwd: before.projectRoot });
    const after = await inspectBuilderFlowSession({ sessionDir: input.sessionDir });
    const binding = builderBinding(before);
    if (JSON.stringify(binding) !== JSON.stringify(builderBinding(after))) {
      throw new Error("Builder session changed while its multi-cursor schedule was executing");
    }
    const evidence: BuilderFlowScheduleEvidence = {
      schemaVersion: "1.0",
      kind: "kontourai.builder.multi-cursor-schedule",
      builderRun: binding,
      schedule,
    };
    const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const file = path.join(before.sessionDir, `${path.basename(before.sessionDir)}--multi-cursor-schedule-${digest}.json`);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== bytes) {
      throw new Error("content-addressed Builder schedule artifact conflicts with existing bytes");
    }
    if (!fs.existsSync(file)) atomicWriteFile(before.sessionDir, file, bytes);
    return {
      evidence,
      evidenceRef: {
        kind: "artifact",
        file: path.relative(before.projectRoot, file).split(path.sep).join("/"),
        summary: "Builder-bound Flow multi-cursor schedule and mutable-resource conflict evidence.",
      },
    };
  });
}
