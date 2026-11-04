// Local workflow lint. The compute policy is checked first, on the original YAML.
// actionlint then reads the real workflow files: the workflows no longer use
// any key it cannot parse, so no lowered copies are needed.
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadWorkflows, validate, root } from './compute-policy.mjs';

export function lint() {
  validate(loadWorkflows());
  const files = Object.keys(loadWorkflows()).map(name => join(root, '.github/workflows', name));
  // Shellcheck remains a separate tool; this invocation checks workflow schema,
  // expressions, needs, matrix and reusable-call keyword support.
  const result = spawnSync('actionlint', ['-shellcheck=', '-pyflakes=', ...files], { encoding: 'utf8', cwd: root });
  if (result.error) throw new Error(`NOT_VERIFIED: actionlint unavailable: ${result.error.message}`);
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`actionlint failed: ${result.status}`);
}
if (process.argv[1]?.endsWith('/actionlint-compute.mjs')) lint();
