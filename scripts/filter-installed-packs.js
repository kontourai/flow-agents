#!/usr/bin/env node
import("../build/scripts-ts/filter-installed-packs.js").then(({ main }) => process.exit(main(process.argv.slice(2))));
