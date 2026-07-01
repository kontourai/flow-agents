'use strict';

const fs = require('fs');
const path = require('path');

const KONTOURAI_DIR = '.kontourai';
const LEGACY_FLOW_AGENTS_DIR = '.flow-agents';

function flowAgentsArtifactRoot(cwd = process.cwd()) {
  return path.resolve(cwd, KONTOURAI_DIR, 'flow-agents');
}

function legacyFlowAgentsArtifactRoot(cwd = process.cwd()) {
  return path.resolve(cwd, LEGACY_FLOW_AGENTS_DIR);
}

function flowAgentsArtifactRootsForRead(cwd = process.cwd()) {
  const roots = [flowAgentsArtifactRoot(cwd), legacyFlowAgentsArtifactRoot(cwd)];
  return roots.filter((root, index) => roots.indexOf(root) === index && fs.existsSync(root));
}

function defaultArtifactRootForRead(cwd = process.cwd()) {
  const roots = flowAgentsArtifactRootsForRead(cwd);
  return roots[0] || flowAgentsArtifactRoot(cwd);
}

module.exports = {
  flowAgentsArtifactRoot,
  legacyFlowAgentsArtifactRoot,
  flowAgentsArtifactRootsForRead,
  defaultArtifactRootForRead,
};
