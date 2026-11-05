#!/usr/bin/env node
/** Print an inert retirement checklist. This command does not execute its steps. */
import { pathToFileURL } from "node:url";
export const retirementPlan = Object.freeze({
  status: 'not-ready',
  executed: false,
  steps: [
    'Wait for the migration command and its dry-run review before changing the existing store.',
    'Run the migration against an owner-selected copy first. Inspect counts, omissions, confidence and proposed brief entries.',
    'After owner approval, migrate into the authorized memory root. Verify record retrieval, provenance and brief quality before retiring anything.',
    'After independent verification and owner approval, disable the old job using its scheduler and preserve the old store as a read-only archive. Do not delete it.',
    'Keep the archive and the previous job configuration for rollback. To undo, restore access to the archive, restore the previous job configuration, and independently review how to withdraw migrated proposals.',
  ],
  missing: ['production migration command', 'real-store dry run', 'retrieval and brief verification', 'owner approval'],
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(retirementPlan, null, 2)}\n`);
}
