#!/usr/bin/env node
import("../build/src/cli/publish-change-helper.js").then(({ main }) => process.exit(main()));
