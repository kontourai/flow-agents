#!/usr/bin/env node
import("../build/src/cli/effective-backlog-settings.js").then(({ main }) => process.exit(main()));
