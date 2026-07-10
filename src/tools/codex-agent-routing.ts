export const CODEX_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export function codexAgentRoutingErrors(manifest: any, agentNames: Iterable<string>): string[] {
  const errors: string[] = [];
  const knownAgents = new Set(agentNames);
  const allowedModels = manifest.codex?.allowed_agent_models;
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) {
    errors.push("codex.allowed_agent_models must be a non-empty list");
  }
  const allowedModelSet = new Set(Array.isArray(allowedModels) ? allowedModels : []);
  for (const model of allowedModelSet) {
    if (typeof model !== "string" || !model) errors.push("codex.allowed_agent_models entries must be non-empty strings");
  }
  if (allowedModelSet.size !== (Array.isArray(allowedModels) ? allowedModels.length : 0)) {
    errors.push("codex.allowed_agent_models must not contain duplicates");
  }

  for (const [family, model] of Object.entries(manifest.codex_model_map ?? {})) {
    if (!allowedModelSet.has(model)) errors.push(`codex_model_map.${family} uses unsupported model '${String(model)}'`);
  }
  for (const [family, effort] of Object.entries(manifest.codex_reasoning_map ?? {})) {
    if (!CODEX_REASONING_EFFORTS.has(String(effort))) errors.push(`codex_reasoning_map.${family} uses invalid reasoning effort '${String(effort)}'`);
  }

  const agentMap = manifest.codex_agent_map;
  if (!agentMap || typeof agentMap !== "object" || Array.isArray(agentMap)) {
    errors.push("codex_agent_map must be an object");
    return errors;
  }
  for (const [agentName, override] of Object.entries(agentMap)) {
    if (!knownAgents.has(agentName)) errors.push(`codex_agent_map agent '${agentName}' does not exist`);
    if (!override || typeof override !== "object" || Array.isArray(override)) {
      errors.push(`codex_agent_map.${agentName} must be an object`);
      continue;
    }
    const entry = override as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "model,reasoning_effort") {
      errors.push(`codex_agent_map.${agentName} must contain exactly model and reasoning_effort`);
    }
    if (!allowedModelSet.has(entry.model)) {
      errors.push(`codex_agent_map.${agentName}.model uses unsupported model '${String(entry.model)}'`);
    }
    if (!CODEX_REASONING_EFFORTS.has(String(entry.reasoning_effort))) {
      errors.push(`codex_agent_map.${agentName}.reasoning_effort is invalid: '${String(entry.reasoning_effort)}'`);
    }
  }
  return errors;
}
