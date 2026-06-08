#!/usr/bin/env node
import("../build/src/cli/pull-work-provider.js").then(({ main }) => process.exit(main()));
