#!/usr/bin/env node
import("../build/src/cli/promote-workflow-artifact.js").then(({ main }) => process.exit(main()));
