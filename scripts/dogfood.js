#!/usr/bin/env node
/**
 * flow-agents dogfood wrapper.
 *
 * Invokes the dogfood subcommand from init.ts to write hook-wiring artifacts
 * for the specified runtime into the current or target directory.
 *
 * Usage:
 *   node scripts/dogfood.js --runtime claude-code [--dest PATH]
 *   npm run dogfood -- --runtime claude-code [--dest PATH]
 *
 * This script is intentionally thin: it imports the built mainDogfood export
 * from build/src/cli/init.js so all logic stays in one place and cannot drift.
 * Run `npm run build` or `npm run build:bundles` first if the build is stale.
 */
import("../build/src/cli/init.js").then(({ mainDogfood }) => mainDogfood(process.argv.slice(2)).then((rc) => process.exit(rc)));
