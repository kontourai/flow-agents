/**
 * Public library surface for `@kontourai/flow-agents`.
 *
 * Native orchestration hosts can import the canonical workflow-sidecar
 * writer/validator here instead of shelling out to the
 * `flow-agents-workflow-sidecar` CLI or reimplementing validated
 * read / merge / write of workflow evidence. This is the same code the CLI
 * runs — importing it does not execute the CLI.
 *
 * The sidecar JSON Schemas ship under `schemas/` and can be validated against
 * directly; the helpers below are the canonical writer/validator that produce
 * and check conforming artifacts.
 *
 * @module
 */
import * as path from "node:path";
import { loadJson as _loadJson, writeJson as _writeJson } from "./cli/workflow-sidecar.js";

export {
  defaultArtifactRootForRead,
  defaultTelemetryDirForRead,
  defaultTelemetryDirsForRead,
  durableFlowAgentsRoot,
  durableInstallRecordPath,
  DURABLE_FLOW_AGENTS_DIR,
  FLOW_AGENTS_RUNTIME_DIR,
  FLOW_AGENTS_RUNTIME_SUBDIR,
  firstExistingPath,
  flowAgentsArtifactRoot,
  KONTOURAI_DIR,
  legacyTelemetryDataDir,
  LEGACY_TELEMETRY_DIR,
  telemetryDataDir,
} from "./lib/local-artifact-root.js";

export {
  // Trust-bundle (Hachure) validation — the same validator the writer uses.
  validateTrustBundle,
  // Evidence / check / learning validation + normalization. These throw on
  // invalid input (with the same messages the CLI surfaces) and return the
  // normalized object on success.
  normalizeCheck,
  normalizeFinding,
  normalizeLearning,
  normalizeEvidenceRefs,
  validateEvidenceRef,
  validateLearningCorrection,
  // Sidecar read / merge / write primitives.
  loadJson,
  writeJson,
  appendJsonl,
  sidecarBase,
  writeState,
  // Schema vocabularies (the allowed status/phase/kind values).
  statuses,
  phases,
  checkKinds,
  checkStatuses,
  verdicts,
} from "./cli/workflow-sidecar.js";

/** Read a sidecar JSON file from a workflow artifact directory; returns `{}` if absent. */
export function readSidecar(dir: string, name: string): Record<string, any> {
  return _loadJson(path.join(dir, name));
}

/** Write a sidecar JSON file into a workflow artifact directory (pretty-printed, trailing newline). */
export function writeSidecar(dir: string, name: string, payload: Record<string, any>): void {
  _writeJson(path.join(dir, name), payload);
}
