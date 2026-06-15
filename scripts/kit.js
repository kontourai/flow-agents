#!/usr/bin/env node
import("../build/src/cli/kit.js").then(({ main }) => process.exit(main()));
