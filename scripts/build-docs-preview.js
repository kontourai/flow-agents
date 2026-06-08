#!/usr/bin/env node
import("../build/src/cli/docs-preview.js").then(({ main }) => process.exit(main()));
