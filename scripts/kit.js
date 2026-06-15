#!/usr/bin/env node
import("../build/src/cli/kit.js").then(({ main }) => main().then((code) => process.exit(code)));
