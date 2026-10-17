// Local actionlint 1.7.12 cannot parse GitHub's queue property. Only the
// complete reviewed policy shapes may be lowered, in private temporary copies.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseDocument } from 'yaml';
import { assignments, loadWorkflows, validate, root } from './compute-policy.mjs';

export function legacyLintSources(sources) {
  // Validation sees the originals, including every queue/cancel/group property.
  validate(Object.fromEntries(Object.entries(sources).map(([name, text]) => [name, parseDocument(text).toJS()])));
  return Object.fromEntries(Object.entries(sources).map(([name, text]) => {
    const doc = parseDocument(text);
    for (const id of Object.keys(assignments[name] ?? {})) doc.deleteIn(['jobs', id, 'concurrency', 'queue']);
    return [name, doc.toString()];
  }));
}
export function lint() {
  const sources = Object.fromEntries(Object.keys(loadWorkflows()).map(name => [name, readFileSync(join(root, '.github/workflows', name), 'utf8')]));
  const lowered = legacyLintSources(sources);
  const directory = mkdtempSync(join(tmpdir(), 'flow-lint-'));
  try {
    const files = Object.entries(lowered).map(([name, text]) => {
      const path = join(directory, name); writeFileSync(path, text); return path;
    });
    // Shellcheck remains a separate tool; this invocation checks workflow schema,
    // expressions, needs, matrix and reusable-call keyword support.
    const result = spawnSync('actionlint', ['-shellcheck=', '-pyflakes=', ...files], { encoding: 'utf8', cwd: root });
    if (result.error) throw new Error(`NOT_VERIFIED: actionlint unavailable: ${result.error.message}`);
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    if (result.status !== 0) throw new Error(`actionlint failed: ${result.status}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
if (process.argv[1]?.endsWith('/actionlint-compute.mjs')) lint();
