#!/usr/bin/env node
/**
 * Continuation Turn Fence
 *
 * A signed continuation turn is authorized for exactly one canonical Flow
 * step. After a tool advances Flow beyond that issued step, return control to
 * the continuation driver before the model can start work for the next step.
 *
 * Exit codes:
 *   0 = remain in the current adapter turn
 *   3 = the issued gate advanced; return control to the driver
 */

'use strict';

const path = require('path');

const MAX_STDIN = 1024 * 1024;
const SAFE_RUN_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_EVENTS = new Set([
  'pretooluse',
  'posttooluse',
  'tool.execute.before',
  'tool.execute.after',
  'tool_call',
  'tool_result',
]);

async function run(inputOrRaw, options = {}) {
  if (options.truncated) return { exitCode: 0 };

  let input;
  let signedAuthorityValidated = false;
  try {
    input = typeof inputOrRaw === 'string' ? JSON.parse(inputOrRaw) : inputOrRaw;
  } catch {
    return { exitCode: 0 };
  }
  const event = String(input?.hook_event_name || '').trim().toLowerCase();
  if (!TOOL_EVENTS.has(event)) return { exitCode: 0 };

  const runId = process.env.FLOW_AGENTS_CONTINUATION_RUN_ID;
  const turnSecret = process.env.FLOW_AGENTS_CONTINUATION_TURN_SECRET;
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)
    || typeof turnSecret !== 'string' || !turnSecret) return { exitCode: 0 };

  try {
    // Keep the ordinary-session path cheap. The canonical validator and signed
    // authority reader are loaded only inside a real continuation turn.
    const { flowAgentsArtifactRoot } = require('./lib/local-artifact-paths');
    const {
      recordActiveTurnBoundary,
      validateActiveTurnAuthority,
      validateSignedActiveTurnAssignmentAuthority,
    } = require('./lib/continuation-turn-authority');
    const { analyze, canonicalFlowState, findRepoRoot } = require('./stop-goal-fit');
    const root = findRepoRoot(input?.cwd || process.cwd());
    const artifactRoot = path.resolve(flowAgentsArtifactRoot(root));
    const sessionDir = path.resolve(artifactRoot, runId);
    if (path.dirname(sessionDir) !== artifactRoot) return { exitCode: 0 };

    const authority = validateSignedActiveTurnAssignmentAuthority({ sessionDir, runId, turnSecret });
    if (!authority.valid) return { exitCode: 0 };
    signedAuthorityValidated = true;

    const canonical = canonicalFlowState(root, sessionDir);
    if (canonical.error || !canonical.state) {
      return {
        exitCode: 3,
        stderr: 'RETURN_CONTROL: Signed continuation authority remains valid, but canonical Flow ' +
          'identity cannot be proven. End this adapter turn without further tool calls.',
      };
    }
    if (canonical.state.status === 'active') {
      const fullAuthority = validateActiveTurnAuthority({
        sessionDir,
        runId,
        turnSecret,
        canonicalState: canonical.state,
      });
      if (!fullAuthority.valid) {
        return {
          exitCode: 3,
          stderr: `RETURN_CONTROL: Canonical Flow no longer matches the signed continuation turn ` +
            `(${fullAuthority.reason}). End this adapter turn without further tool calls.`,
        };
      }
      if (canonical.state.current_step === authority.record.issued_step) return { exitCode: 0 };
    }

    // #640: after a gate advances, malformed issued-step artifacts remain a
    // legitimate repair obligation in this turn. Stop owns that hard-block
    // classification and its repair-only guidance; do not preempt it.
    const goalFit = await analyze(root);
    if (goalFit.blocking) return { exitCode: 0 };

    recordActiveTurnBoundary({
      sessionDir,
      runId,
      turnSecret,
      canonicalState: canonical.state,
    });
    const current = canonical.state.status === 'active'
      ? `step "${canonical.state.current_step}"`
      : `terminal status "${canonical.state.status}"`;
    return {
      exitCode: 3,
      stderr: `RETURN_CONTROL: Signed continuation turn for step "${authority.record.issued_step}" ` +
        `advanced canonical Flow to ${current}. End this adapter turn now; the continuation ` +
        'driver will issue a fresh turn for any remaining work.',
    };
  } catch {
    if (signedAuthorityValidated) {
      return {
        exitCode: 3,
        stderr: 'RETURN_CONTROL: The signed continuation turn could not prove a safe remaining ' +
          'scope. End this adapter turn without further tool calls.',
      };
    }
    // Without a valid signed continuation authority, this policy grants and
    // revokes nothing; ordinary hooks retain their existing behavior.
    return { exitCode: 0 };
  }
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  let truncated = /^(1|true|yes)$/i.test(String(process.env.SA_HOOK_INPUT_TRUNCATED || ''));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (raw.length < MAX_STDIN) {
      const remaining = MAX_STDIN - raw.length;
      raw += chunk.substring(0, remaining);
      if (chunk.length > remaining) truncated = true;
    } else {
      truncated = true;
    }
  });
  process.stdin.on('end', () => {
    Promise.resolve(run(raw, { truncated, maxStdin: MAX_STDIN })).then(result => {
      if (result.stderr) process.stderr.write(`${result.stderr}\n`);
      process.exit(result.exitCode);
    }).catch(() => process.exit(0));
  });
}
