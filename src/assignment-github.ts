/**
 * Stable contract subpath: `@kontourai/flow-agents/assignment-github`.
 *
 * The GitHub provider for the assignment primitive, pure and render-don't-execute: the `render*`
 * functions return the exact `gh` argv arrays and claim-comment body as data for the caller to
 * run, and `githubAssignmentStatus` / `extractGithubClaimRecord` parse an already-fetched issue.
 * No `fs`, `child_process`, or `gh` execution. The issue-shaped `work_item_ref`
 * (`owner/repo#number`) validation lives here, not in `assignment-contract`.
 *
 * A host's own store can export records that the Flow CLI reads unchanged by writing the claim
 * comment `renderGithubClaimCommentBody` produces and the codec in `assignment-contract` decodes.
 *
 * @module
 */
export {
  GITHUB_CLAIM_COMMENT_MARKER_DEFAULT,
  GITHUB_CLAIM_LABEL_DEFAULT,
  extractGithubClaimRecord,
  githubAssignmentStatus,
  renderGithubClaim,
  renderGithubClaimCommentBody,
  renderGithubRelease,
  renderGithubSupersede,
} from "./lib/assignment-github.js";
export type {
  AssignmentRenderResult,
  GithubAssignmentStatus,
  GithubIssueDoc,
  RenderClaimInput,
} from "./lib/assignment-github.js";
