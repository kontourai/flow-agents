import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Ensure `.kontourai/` carries its own ignore rule.
 *
 * Lifted out of `init` (#1264) because init is no longer the only writer: the CLI now
 * records a transition on every invocation, in every repository it is run from,
 * including ones where this kit was never installed. Without the rule, a read-only
 * command like `--help` leaves untracked residue that a developer can commit —
 * carrying their filesystem layout and session ids into whatever repository they
 * happened to be standing in.
 */
export function ensureArtifactResidueIgnored(dest: string): void {
  // At `.kontourai/`, not `.kontourai/flow-agents/`. Scoping it to the flow-agents
  // artifact root was measured and found insufficient: the Flow engine writes its own run
  // records to the sibling `.kontourai/flow/`, which stayed untracked-and-visible and kept
  // the tree dirty at capture time. One ignore at the shared root covers both, and matches
  // what this repository does in its own .gitignore.
  const artifactRoot = path.join(dest, ".kontourai");
  const ignorePath = path.join(artifactRoot, ".gitignore");
  // A first attempt at this ignored only the obviously transient residue (transaction
  // directories and lock files) and left the durable artifacts tracked, so a project could
  // still choose to commit them. Measured against a real run, that was not enough: the
  // writer also creates state.json, the command log and the trust bundle while the command
  // it is observing runs, so the tree is dirty at capture time regardless. The reference
  // posture is this repository's own .gitignore, which ignores `.kontourai/` wholesale.
  //
  // The trade is explicit: run state is machine-regenerable local evidence, not source. A
  // project that genuinely wants to commit artifacts can delete or edit this file, which is
  // why it is never overwritten once present.
  const desired = [
    "# Written by flow-agents init (#1264).",
    "#",
    "# The evidence writer captures Git provenance AT COMMAND-EXECUTION TIME, from this",
    "# directory, while it is writing state.json, the command log and lock files. Without",
    "# this file it sees its own writes as a dirty working tree and refuses its own",
    "# observation -- with an error naming the precondition, not the cause.",
    "#",
    "# Run state is regenerable local evidence, not source. To commit artifacts anyway,",
    "# edit or delete this file; init will not recreate it.",
    "*",
    "!.gitignore",
    "",
  ].join("\n");
  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    // `wx` creates EXCLUSIVELY: a project may have written its own rules here, and
    // silently replacing them would be the user-data-loss class #1238 covered. Review
    // flagged the original existsSync-then-write as a check/write race; open-exclusive
    // closes it at the syscall.
    fs.writeFileSync(ignorePath, desired, { mode: 0o644, flag: "wx" });
  } catch (error) {
    // An existing file is the expected, silent case. Anything ELSE is reported: review
    // flagged the original bare catch as broad enough to swallow a real defect.
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      console.error(`init: could not write ${ignorePath} (${(error as Error)?.message ?? error}); the evidence writer may refuse command evidence in this repo (#1264)`);
    }
  }
}
