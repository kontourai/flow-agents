#!/usr/bin/env node
import("../build/src/tools/build-universal-bundles.js").then(({ main }) => process.exit(main()));
