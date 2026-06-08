#!/usr/bin/env node
import("../build/src/cli/validate-hook-influence.js").then(({ main }) => process.exit(main(process.argv.slice(2))));
