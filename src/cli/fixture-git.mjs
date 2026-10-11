import { execFileSync } from "node:child_process";

// Synthetic repositories should run their own hooks, not the developer's
// ambient global hooks. Keep normal Git hook behavior and explicit later
// overrides intact; never change the real checkout or global configuration.
export function useFixtureGitHooks(projectRoot) {
  execFileSync("git", ["config", "--local", "core.hooksPath", ".git/hooks"], {
    cwd: projectRoot,
    stdio: "ignore",
  });
}
