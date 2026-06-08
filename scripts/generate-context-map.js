#!/usr/bin/env node
import("../build/scripts-ts/generate-context-map.js").then(({ main }) => process.exit(main(process.argv.slice(2))));
