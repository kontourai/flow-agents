// The workflow sidecar's status and phase vocabulary and its JSON writer, kept apart from
// cli/workflow-sidecar so a host can import them without loading the sidecar's dependency graph
// (flow resolver, builder flow runtime, @kontourai/flow, assignment provider). cli/workflow-sidecar
// re-exports these exact bindings, so callers that compare instances see one Set and one array.
import * as fs from "node:fs";
import * as path from "node:path";
import { writeStateJson } from "./state-file-lock.js";

export const statuses = new Set(["new", "planning", "planned", "in_progress", "blocked", "verifying", "verified", "needs_decision", "not_verified", "failed", "delivered", "canceled", "accepted", "archived"]);
export const phases = ["idea", "backlog", "pickup", "planning", "execution", "verification", "goal_fit", "evidence", "release", "learning", "done"];

export function writeJson(file: string, payload: Record<string, any>): void {
  if (path.basename(file) === "state.json") {
    writeStateJson(file, payload);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}
