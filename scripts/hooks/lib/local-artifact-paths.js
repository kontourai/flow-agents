'use strict';

const fs = require('fs');
const path = require('path');

const KONTOURAI_DIR = '.kontourai';
const FLOW_AGENTS_RUNTIME_SUBDIR = 'flow-agents';
const FLOW_AGENTS_RUNTIME_DIR = `${KONTOURAI_DIR}/${FLOW_AGENTS_RUNTIME_SUBDIR}`;
const DURABLE_FLOW_AGENTS_DIR = '.flow-agents';

function flowAgentsArtifactRoot(cwd = process.cwd()) {
  return path.resolve(cwd, FLOW_AGENTS_RUNTIME_DIR);
}

function durableFlowAgentsRoot(cwd = process.cwd()) {
  return path.resolve(cwd, DURABLE_FLOW_AGENTS_DIR);
}

function flowAgentsArtifactRootsForRead(cwd = process.cwd()) {
  const roots = [flowAgentsArtifactRoot(cwd)];
  return roots.filter((root, index) => roots.indexOf(root) === index && fs.existsSync(root));
}

function defaultArtifactRootForRead(cwd = process.cwd()) {
  const roots = flowAgentsArtifactRootsForRead(cwd);
  return roots[0] || flowAgentsArtifactRoot(cwd);
}

module.exports = {
  DURABLE_FLOW_AGENTS_DIR,
  FLOW_AGENTS_RUNTIME_DIR,
  FLOW_AGENTS_RUNTIME_SUBDIR,
  KONTOURAI_DIR,
  durableFlowAgentsRoot,
  flowAgentsArtifactRoot,
  flowAgentsArtifactRootsForRead,
  defaultArtifactRootForRead,
};
