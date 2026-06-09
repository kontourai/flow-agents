#!/usr/bin/env node
import("../build/src/tools/filter-installed-packs.js").then(({ main }) => process.exit(main(process.argv.slice(2))));
