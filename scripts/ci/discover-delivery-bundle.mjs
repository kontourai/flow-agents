#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PER_SESSION_BUNDLE = /^delivery\/[a-z0-9]+(?:-[a-z0-9]+)*\/trust\.bundle$/;

export function discoverDeliveryBundle({ repoRoot, requestedPath = 'delivery/trust.bundle', baseSha, head = 'HEAD' }) {
  if (requestedPath && existsSync(resolve(repoRoot, requestedPath))) return requestedPath;
  if (!baseSha) return '';

  const changed = execFileSync(
    'git',
    ['diff', '--name-only', `${baseSha}...${head}`, '--', 'delivery/*/trust.bundle'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => PER_SESSION_BUNDLE.test(value) && existsSync(resolve(repoRoot, value)));

  if (changed.length > 1) {
    throw new Error(`multiple changed per-session trust bundles found: ${changed.join(', ')}`);
  }
  return changed[0] ?? '';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.stdout.write(discoverDeliveryBundle({
      repoRoot: resolve(process.argv[2] ?? process.cwd()),
      requestedPath: process.argv[3] ?? 'delivery/trust.bundle',
      baseSha: process.argv[4] || undefined,
      head: process.argv[5] ?? 'HEAD',
    }));
  } catch (error) {
    process.stderr.write(`[trust-verify] ${error.message}\n`);
    process.exitCode = 2;
  }
}
