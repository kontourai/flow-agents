#!/usr/bin/env node
import("node:child_process").then(({ spawnSync }) => {
  const result = spawnSync("npm", ["run", "validate:source", "--silent", "--", ...process.argv.slice(2)], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
});
