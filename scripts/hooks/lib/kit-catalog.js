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
    lines.push(`Keep the session on \`${targetFlowId}\` and use \`npm run workflow:sidecar -- ensure-session --flow-id ${targetFlowId} ...\` when the repo provides the sidecar writer.`);
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

function workflowTriggersFor(root, when) {
  const result = [];
  const inventory = readKitManifests(root);
  for (const kit of inventory.kits) {
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
};
