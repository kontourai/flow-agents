#!/usr/bin/env node
import("../build/src/cli/flow-kit.js").then(({ main }) => process.exit(main()));
