'use strict';

const fs = require('fs');
const path = require('path');

const KIT_ID_RE = /^[a-z][a-z0-9-]*$/;
const WORKFLOW_TRIGGER_IDENTIFIER_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const MAX_STEERING_VALUE_LENGTH = 240;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function containedPath(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel)) return null;
  const resolved = path.resolve(root, rel);
  const absRoot = path.resolve(root);
  if (resolved === absRoot || resolved.startsWith(`${absRoot}${path.sep}`)) return resolved;
  return null;
}

function loadKitManifest(kitRoot, sourceKind, warnings) {
  const manifestPath = path.join(kitRoot, 'kit.json');
  try {
    if (!fs.existsSync(manifestPath)) return null;
    const manifest = readJson(manifestPath);
    const kitId = typeof manifest.id === 'string' ? manifest.id : '';
    if (!KIT_ID_RE.test(kitId)) {
      warnings.push(`${manifestPath}: kit id must be a kebab-case id (^[a-z][a-z0-9-]*$); skipping kit`);
      return null;
    }
    return { kit_id: kitId, source_kind: sourceKind, manifest };
  } catch (error) {
    warnings.push(`${manifestPath}: ${String(error && error.message ? error.message : error)}`);
    return null;
  }
}

function readKitManifests(root) {
  const warnings = [];
  const kits = [];
  const catalogPath = path.join(root, 'kits', 'catalog.json');
  if (fs.existsSync(catalogPath)) {
    try {
      const catalog = readJson(catalogPath);
      if (Array.isArray(catalog.kits)) {
        for (const entry of catalog.kits) {
          const rel = entry && typeof entry === 'object' ? entry.path : undefined;
          const kitRoot = containedPath(root, rel);
          if (!kitRoot || !fs.existsSync(kitRoot)) continue;
          const loaded = loadKitManifest(kitRoot, 'builtin', warnings);
          if (loaded) kits.push(loaded);
        }
      }
    } catch (error) {
      warnings.push(String(error && error.message ? error.message : error));
    }
  }

  const registryPath = path.join(root, 'kits', 'local', 'installed-kits.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = readJson(registryPath);
      if (Array.isArray(registry.kits)) {
        for (const entry of registry.kits) {
          const id = entry && typeof entry === 'object' ? entry.id : undefined;
          if (typeof id !== 'string') continue;
          const kitRoot = path.join(root, 'kits', 'local', 'repositories', id);
          if (!fs.existsSync(kitRoot)) continue;
          const loaded = loadKitManifest(kitRoot, 'local', warnings);
          if (loaded) kits.push(loaded);
        }
      }
    } catch (error) {
      warnings.push(String(error && error.message ? error.message : error));
    }
  }
  return { kits, warnings };
}

function isWorkflowTriggerIdentifier(value) {
  return typeof value === 'string' && WORKFLOW_TRIGGER_IDENTIFIER_RE.test(value);
}

function optionalWorkflowTriggerIdentifier(value) {
  return value === undefined || isWorkflowTriggerIdentifier(value);
}

function optionalWorkflowTriggerIdentifierList(value) {
  return value === undefined ||
    (Array.isArray(value) && value.length > 0 && value.every(isWorkflowTriggerIdentifier));
}

function optionalConditionalSkills(value) {
  return value === undefined ||
    (Array.isArray(value) && value.every(item =>
      item && typeof item === 'object' &&
      isWorkflowTriggerIdentifier(item.when) &&
      isWorkflowTriggerIdentifier(item.skill)
    ));
}

function renderKitSteering(trigger) {
  const kitId = isWorkflowTriggerIdentifier(trigger.kit_id) ? trigger.kit_id : '';
  const category = isWorkflowTriggerIdentifier(trigger.when) ? trigger.when : 'matching';
  const targetFlowId = isWorkflowTriggerIdentifier(trigger.target_flow_id) ? trigger.target_flow_id : '';
  const defaultSkill = isWorkflowTriggerIdentifier(trigger.default_skill) ? trigger.default_skill : '';
  const conditionalSkills = Array.isArray(trigger.conditional_skills) ? trigger.conditional_skills
    .map(item => ({
      when: isWorkflowTriggerIdentifier(item && item.when) ? item.when : '',
      skill: isWorkflowTriggerIdentifier(item && item.skill) ? item.skill : '',
    }))
    .filter(item => item.when && item.skill) : [];
  const requiredSequence = Array.isArray(trigger.required_sequence)
    ? trigger.required_sequence.filter(isWorkflowTriggerIdentifier)
    : [];
  const postVerifyTargets = Array.isArray(trigger.post_verify_targets)
    ? trigger.post_verify_targets.filter(isWorkflowTriggerIdentifier)
    : [];

  const lines = [
    `KIT WORKFLOW ROUTE: this user prompt matches ${category}.`,
  ];
  if (kitId && targetFlowId) {
    lines.push(`Before source edits or implementation commands, use the \`${kitId}\` kit's \`${targetFlowId}\` workflow.`);
  } else if (kitId) {
    lines.push(`Before source edits or implementation commands, use the \`${kitId}\` kit workflow.`);
  } else {
    lines.push('Before source edits or implementation commands, use the matching kit workflow.');
  }
  if (conditionalSkills.length || defaultSkill) {
    const conditionalText = conditionalSkills
      .map(item => `If ${item.when}, activate \`${item.skill}\``)
      .join('; ');
    if (conditionalText && defaultSkill) lines.push(`${conditionalText}; otherwise activate \`${defaultSkill}\`.`);
    else if (conditionalText) lines.push(`${conditionalText}.`);
    else lines.push(`Activate \`${defaultSkill}\`.`);
  }
  if (targetFlowId) {
    lines.push(`Keep the session on \`${targetFlowId}\`. Use the public \`flow-agents workflow\` interface only when it supports that Flow and its Work Item binding; otherwise report an unsupported-runtime blocker. Never call the package-internal writer from skill guidance.`);
  }
  if (requiredSequence.length) {
    lines.push(`Do not bypass ${requiredSequence.join(' -> ')} for matching work.`);
  }
  if (postVerifyTargets.length) {
    lines.push(`After local verification, continue to ${postVerifyTargets.join(' and ')}; do not treat local verification as terminal delivery.`);
  }
  return lines.join(' ');
}

function workflowTriggerValidationErrors(manifest, manifestPath) {
  const errors = [];
  const raw = manifest.workflow_triggers;
  if (raw === undefined) return errors;
  if (!Array.isArray(raw)) {
    errors.push(`${manifestPath}: .workflow_triggers must be a list`);
    return errors;
  }
  const seenIds = new Set();
  raw.forEach((trigger, index) => {
    if (!trigger || typeof trigger !== 'object') {
      errors.push(`${manifestPath}: workflow_triggers[${index}] must be an object`);
      return;
    }
    if (!isWorkflowTriggerIdentifier(trigger.id)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].id must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$`);
      return;
    }
    if (seenIds.has(trigger.id)) errors.push(`${manifestPath}: workflow_triggers[${index}].id duplicates '${trigger.id}'`);
    seenIds.add(trigger.id);
    if (!isWorkflowTriggerIdentifier(trigger.when)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].when must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$`);
      return;
    }
    if (trigger.hint !== undefined) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].hint is retired; use structured steering fields`);
      return;
    }
    if (trigger.display_name !== undefined) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].display_name is not supported in workflow_triggers; use catalog/listing metadata for human-readable names`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifier(trigger.target_flow_id)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].target_flow_id must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifier(trigger.default_skill)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].default_skill must match ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalConditionalSkills(trigger.conditional_skills)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].conditional_skills must be a list of { when, skill } identifiers matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifierList(trigger.required_sequence)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].required_sequence must be a non-empty identifier list matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
      return;
    }
    if (!optionalWorkflowTriggerIdentifierList(trigger.post_verify_targets)) {
      errors.push(`${manifestPath}: workflow_triggers[${index}].post_verify_targets must be a non-empty identifier list matching ^[a-z0-9]+(?:[.-][a-z0-9]+)*$ when present`);
    }
  });
  return errors;
}

/**
 * Read the built-in kit activation registry (`<root>/.flow-agents/install.json`'s `active_kits`
 * field -- see src/lib/kit-registry.ts) and return the set of active BUILT-IN kit ids, or null
 * when no filtering decision can be made: the durable install record is absent, unreadable, or
 * (a legacy pre-activation-registry install) simply has no `active_kits` field at all. Callers
 * treat null as "leave current behavior unchanged" -- deliberately fail-open, never fail-closed,
 * so an install that predates this feature (or one whose install.json is momentarily
 * unreadable) keeps steering every installed built-in kit exactly as it always has.
 *
 * r1 review HIGH finding: a PRESENT-but-fully-malformed `active_kits` array (every entry missing
 * or wrong-typed `id` -- a plausible hand-edit or merge artifact) used to return an empty, non-
 * null `Set`, which the caller cannot tell apart from a deliberate "zero kits active" state --
 * silently suppressing EVERY built-in kit's `workflow_triggers` with no signal anywhere. Fixed
 * two ways: (1) a malformed entry is now skipped INDIVIDUALLY, so a partially-malformed array
 * still honors its valid entries instead of discarding the whole array; (2) only when the array
 * is non-empty AND every single entry turned out to be unusable does this fall back to the
 * fail-open `null` contract above (indistinguishable from corruption, not a genuine "nothing
 * active" decision) -- and, unlike the other `null` cases, that one prints a single stderr
 * diagnostic naming the corruption, because silently reinterpreting "can't decide" as "everything
 * is active" must never be as quiet as the ordinary legacy/absent case.
 */
function readActiveBuiltinKitIds(root) {
  try {
    const installJsonPath = path.join(root, '.flow-agents', 'install.json');
    if (!fs.existsSync(installJsonPath)) return null;
    const record = readJson(installJsonPath);
    if (!record || !Array.isArray(record.active_kits)) return null;
    const ids = new Set();
    let malformedCount = 0;
    for (const entry of record.active_kits) {
      if (entry && typeof entry === 'object' && typeof entry.id === 'string' && entry.id) {
        ids.add(entry.id);
      } else {
        malformedCount += 1;
      }
    }
    if (record.active_kits.length > 0 && ids.size === 0) {
      process.stderr.write(
        `[flow-agents] WARNING: ${installJsonPath}: active_kits has ${malformedCount} ` +
        `entr${malformedCount === 1 ? 'y' : 'ies'} and none has a valid id -- cannot determine ` +
        `which built-in kits are active. Failing open: steering every installed built-in kit's ` +
        `workflow_triggers as if active_kits were absent, not treating this as zero active kits. ` +
        `Repair or regenerate this install's active_kits (kontourai/flow-agents kit-activation-registry).\n`
      );
      return null;
    }
    return ids;
  } catch {
    return null;
  }
}

function workflowTriggersFor(root, when) {
  const result = [];
  const inventory = readKitManifests(root);
  // Built-in-kit activation lifecycle (kontourai/flow-agents kit-activation-registry): a
  // deactivated BUILT-IN kit's workflow_triggers are not loaded, so a deactivated kit stops
  // steering sessions toward it without any engine code needing to know its name. Scoped to
  // `source_kind === 'builtin'` only -- a locally-installed third-party kit
  // (`kits/local/installed-kits.json`) already has its own independent activation lifecycle
  // (presence in that registry IS its activation), so it is never filtered here.
  const activeBuiltinKitIds = readActiveBuiltinKitIds(root);
  for (const kit of inventory.kits) {
    if (kit.source_kind === 'builtin' && activeBuiltinKitIds && !activeBuiltinKitIds.has(kit.kit_id)) continue;
    const triggers = kit.manifest.workflow_triggers;
    if (!Array.isArray(triggers)) continue;
    const manifestPath = path.join(root, kit.source_kind === 'local' ? 'kits/local/repositories' : 'kits', kit.kit_id, 'kit.json');
    const parseErrors = workflowTriggerValidationErrors(kit.manifest, manifestPath);
    if (parseErrors.length) {
      const warning = `${kit.kit_id}: invalid workflow_triggers metadata; skipping workflow_triggers: ${parseErrors.join('; ')}`;
      inventory.warnings.push(warning);
      process.stderr.write(`[flow-agents] ${warning}\n`);
      continue;
    }
    for (const trigger of triggers) {
      if (trigger.when !== when) continue;
      const steering = renderKitSteering({ ...trigger, kit_id: kit.kit_id });
      if (!steering) continue;
      result.push({ kit_id: kit.kit_id, id: trigger.id, when, steering });
    }
  }
  return result;
}

module.exports = {
  MAX_STEERING_VALUE_LENGTH,
  renderKitSteering,
  readKitManifests,
  workflowTriggersFor,
  readActiveBuiltinKitIds,
};
