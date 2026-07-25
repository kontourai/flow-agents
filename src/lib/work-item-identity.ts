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

function parseGitHubWorkItemRef(ref: string): { owner: string; name: string; issueNumber: number } {
  const match = ref.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/);
  if (!match) throw new Error("--work-item must be an exact owner/repo#positive-numeric-id reference");
  const issueNumber = Number(match[3]);
  if (!Number.isSafeInteger(issueNumber)) throw new Error("--work-item issue number exceeds the safe integer range");
  return { owner: match[1]!, name: match[2]!, issueNumber };
}

export function workItemSlug(ref: string): string {
  const hashIdx = ref.indexOf("#");
  if (hashIdx < 0) {
    if (!/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..")) {
      throw new Error("--work-item must be a provider-neutral provider:id ref or owner/repo#numeric-id");
    }
    return slugPart(ref, "work-item");
  }
  const parsed = parseGitHubWorkItemRef(ref);
  return slugPart(`${parsed.owner}-${parsed.name}-${parsed.issueNumber}`, "work-item");
}

export function githubWorkItemIdentity(ref: string): GitHubWorkItemIdentity {
  const parsed = parseGitHubWorkItemRef(ref);
  return {
    owner: parsed.owner,
    name: parsed.name,
    issueNumber: parsed.issueNumber,
    ref,
    slug: workItemSlug(ref),
  };
}
