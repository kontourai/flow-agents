#!/usr/bin/env node
/**
 * Report-Only Guard Hook
 *
 * Blocks ALL file writes. Wire this to reviewer/verifier agents
 * that must only report findings, never modify code.
 *
 * Exit codes: 0 = allow, 2 = block
 */

'use strict';

function run() {
  return {
    exitCode: 2,
    stderr: 'BLOCKED: This agent is report-only — it cannot modify files. ' +
      'Report findings to the orchestrator, which routes fixes back through execute-plan.',
  };
}

module.exports = { run };
