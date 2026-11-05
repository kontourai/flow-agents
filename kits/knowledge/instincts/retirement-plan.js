#!/usr/bin/env node
/** Print an inert retirement checklist. This command does not execute its steps. */
import { pathToFileURL } from 'node:url';

export const retirementPlan = Object.freeze({
  status: 'not-ready',
  executed: false,
  steps: [
    'Identify the existing store and its scheduler in your own configuration. Do not guess their paths or job names.',
    'Use the read-only migration preview on a copy and wait for a live migration command before changing the existing store.',
    'Run the migration against an owner-selected copy first. Inspect counts, omissions, confidence and proposed brief entries.',
    'After owner approval, migrate into the authorized memory root. Verify record retrieval, provenance and brief quality before retiring anything.',
    'After independent verification and owner approval, save the old job configuration, disable that job using its scheduler, and preserve the old store as a read-only archive. Do not delete it.',
    'Before rollback, stop the new dream path to avoid two writers. Review every version 1.3 proposal: an applied proposal may prevent rollback, and its recovery path is not verified.',
    'Once a recovery path is confirmed, restore access to the archive and the saved job configuration. How to withdraw migrated proposals remains unverified.',
  ],
  missing: ['live migration command', 'real-store dry run', 'retrieval and brief verification', 'owner approval'],
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--help')) {
    process.stderr.write('Usage from the repository root: node kits/knowledge/instincts/retirement-plan.js [--help]\n');
    process.exitCode = 2;
  } else if (args[0] === '--help') {
    process.stdout.write('Usage from the repository root: node kits/knowledge/instincts/retirement-plan.js [--help]\nPrint the incomplete retirement checklist. This command makes no changes.\n');
  } else {
    process.stdout.write(`Retirement plan: not ready yet. This command makes no changes.\n\n${retirementPlan.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\nStill needed: ${retirementPlan.missing.join('; ')}.\n`);
  }
}
