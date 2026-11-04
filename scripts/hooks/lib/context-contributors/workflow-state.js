'use strict';
const path = require('node:path');

// The legacy steering logic remains intact, including its recovery fence and
// state emission guard. Dependencies are the host's existing policy helpers.
function workflowStateContributor(deps, rawInput) {
  const { safeStateText, findRepoRoot, resetStateEmission, latestWorkflowState,
    withFlowRecoveryFenceRead, canonicalGuidance, stateSteering,
    stateNeedsAmbientSteering, stateBlockChanged, kitWorkflowSteering,
    supersessionSteering, resumeSteering, contextMapSteering, skillDriftSteering,
    installFreshnessSteering } = deps;
function renderWorkflowState(rawInput, _options = {}, fencedRunId = null) {
  try {
    const input = JSON.parse(rawInput);
    const event = input.hook_event_name || '';
    const { resolveHookWorkflowScope } = require('../hook-workflow-scope.js');
    const scope = resolveHookWorkflowScope(input.cwd || process.cwd());
    if (['invalid', 'ambiguous'].includes(scope.status)) {
      return `${rawInput}\n\n---\nWORKFLOW BINDING ${scope.status.toUpperCase()}: ${safeStateText(scope.reason)}. Resolve the selected binding through its public workflow interface.\n---`;
    }
    const root = scope.projectRoot || findRepoRoot(input.cwd || process.cwd());
    // #1172: reset the STATE hash-guard at every SessionStart, whatever the `source`
    // (startup/resume/compact) and whether or not an active session exists. Done before any
    // steering is composed so a SessionStart that emits nothing still clears the record.
    if (event === 'SessionStart') resetStateEmission(root);
    const current = latestWorkflowState(root);
    if (current && fencedRunId === null) {
      const selectedRunId = path.basename(path.dirname(current.file));
      try {
        return withFlowRecoveryFenceRead(root, selectedRunId, () => renderWorkflowState(rawInput, {}, selectedRunId));
      } catch (error) {
        return `${rawInput}\n\n---\nWORKFLOW RECOVERY ACTIVE: ${safeStateText(error && error.message || error)}. Canonical state is unavailable until recovery completes.\n---`;
      }
    }
    if (!current && fencedRunId !== null) throw new Error("workflow session selection disappeared during fenced read");
    if (current && fencedRunId !== path.basename(path.dirname(current.file))) throw new Error("workflow session selection changed during fenced read");
    const guidance = current ? canonicalGuidance(root, current) : { kind: 'legacy' };
    const hints = [];

    if (event === 'UserPromptSubmit' && current) {
      const stateHint = stateSteering(root, current, guidance);
      if (stateHint) {
        const stateBlock = [];
        if (guidance.kind === 'legacy') {
          stateBlock.push(stateNeedsAmbientSteering(current.payload)
            ? 'WORKFLOW STATE ATTENTION: current sidecars show unresolved workflow state at turn start.'
            : 'WORKFLOW STATE: an active task is in progress — re-ground the recorded goal and resume the next step before doing anything else.');
        }
        stateBlock.push(stateHint);
        // #1172: push the state delta once. An identical block on the next turn is suppressed
        // until the state actually changes or a SessionStart resets the guard.
        if (stateBlockChanged(root, stateBlock.join('\n'))) hints.push(...stateBlock);
      }
    }

    if (event === 'UserPromptSubmit' && guidance.kind === 'legacy') {
      const kitHint = kitWorkflowSteering(input, root);
      if (kitHint) hints.push(kitHint);
    }

    // Every-turn supersession notice (#293): fires on UserPromptSubmit (every turn),
    // not just SessionStart, so a takeover mid-session keeps surfacing the warning.
    if (event === 'UserPromptSubmit' && current) {
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
    }

    // SessionStart only: append the RESUME block for richer situational awareness
    if (event === 'SessionStart' && current) {
      const resumeBlock = resumeSteering(root, current, guidance);
      if (resumeBlock) hints.push(resumeBlock);
      const supersessionHint = supersessionSteering(root, current);
      if (supersessionHint) hints.push(supersessionHint);
    }

    // SessionStart only, unconditional of `current`: boundary orientation that does not depend on
    // there being an active session.
    //   - the context-map pointer (#1172 review HIGH-1): it was previously nested inside the
    //     `current`-gated block, so a SessionStart with NO active session — a fresh checkout, or
    //     the gap between two pieces of work, which is exactly when an index is worth most —
    //     emitted nothing. The every-turn call sites that used to paper over that case are gone,
    //     so the header's placement rule ("boundaries get the full re-grounding push") only holds
    //     if this is unconditional.
    //   - the installed-skill drift advisory (#439): fires on every SessionStart inside a
    //     kit-bearing checkout — do NOT fold it into the `current`-gated block above.
    //   - the install-freshness advisory (#1180 PR 2): whether the INSTALL running these hooks is
    //     itself behind. Boundary-only for the same reason as the rest of this block, and one
    //     stronger: an install cannot go stale mid-session, so a per-turn copy would be pure
    //     context overhead. It must never be added to the UserPromptSubmit paths above.
    if (event === 'SessionStart') {
      const contextHint = contextMapSteering(root);
      if (contextHint) hints.push(contextHint);
      const driftHint = skillDriftSteering(root);
      if (driftHint) hints.push(driftHint);
      const freshnessHint = installFreshnessSteering(root);
      if (freshnessHint) hints.push(freshnessHint);
    }

    if (hints.length === 0) return rawInput;

    const steering = '\n\n---\n' + hints.join('\n') + '\n---';
    return rawInput + steering;
  } catch { /* pass through */ }
  return rawInput;
}


  return (_event, _payload, _budget) => {
    const result = renderWorkflowState(rawInput);
    return { priority: 100, text: result.startsWith(rawInput) ? result.slice(rawInput.length) : '' };
  };
}
module.exports = { workflowStateContributor };
