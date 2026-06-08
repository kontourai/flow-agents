#!/usr/bin/env node
// Supports FLOW_AGENTS_PACKS through the TypeScript bundle builder.
import("../build/scripts-ts/build-universal-bundles.js").then(({ main }) => process.exit(main()));
