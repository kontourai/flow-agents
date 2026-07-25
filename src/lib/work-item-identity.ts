export type GitHubWorkItemIdentity = {
  owner: string;
  name: string;
  issueNumber: number;
  ref: string;
  slug: string;
};

function slugPart(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || fallback;
}

export function workItemSlug(ref: string): string {
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) {
    if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..")) {
      throw new Error("--work-item must be a provider-neutral provider:id ref or owner/repo#numeric-id");
    }
    return slugPart(ref, "work-item");
  }
  if (hashIdx === ref.length - 1) throw new Error("--work-item must be in owner/repo#numeric-id format");
  const repoPath = ref.slice(0, hashIdx);
  const id = ref.slice(hashIdx + 1);
  if (!/^\d+$/.test(id)) throw new Error("--work-item id must be a numeric issue number");
  const parts = repoPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("--work-item repo must be owner/repo format");
  return slugPart(`${parts[0]}-${parts[1]}-${id}`, "work-item");
}

export function githubWorkItemIdentity(ref: string): GitHubWorkItemIdentity {
  const match = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/);
  if (!match) throw new Error("GitHub assignment ownership requires an exact owner/repo#numeric-id Work Item reference");
  const issueNumber = Number(match[3]);
  if (!Number.isSafeInteger(issueNumber)) throw new Error("GitHub Work Item issue number exceeds the safe integer range");
  return {
    owner: match[1]!,
    name: match[2]!,
    issueNumber,
    ref,
    slug: workItemSlug(ref),
  };
}
