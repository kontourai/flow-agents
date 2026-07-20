import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

const TRUSTED_GIT_CANDIDATES = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"];

export function trustedGitExecutable(): string {
  for (const candidate of TRUSTED_GIT_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o022) === 0) return fs.realpathSync(candidate);
    } catch { /* try the next fixed system location */ }
  }
  throw new Error("no protected system Git executable is available");
}

export function assertTrustedGitAncestor(cwd: string, ancestor: string, descendant: string): void {
  execFileSync(trustedGitExecutable(), ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
  });
}
