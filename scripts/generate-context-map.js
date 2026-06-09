#!/usr/bin/env node
import("../build/src/tools/generate-context-map.js").then(({ main }) => process.exit(main(process.argv.slice(2))));
