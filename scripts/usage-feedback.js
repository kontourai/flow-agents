#!/usr/bin/env node
import("../build/src/cli/usage-feedback.js").then(({ main }) => process.exit(main()));
