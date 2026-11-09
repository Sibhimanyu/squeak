import { createHash } from "node:crypto";
import { asProjectId, type ProjectId, type RepositoryReference } from "./types.js";

/** git@host:org/repo.git, https://host/org/repo, ssh://git@host/org/repo.git -> host/org/repo */
export function normalizeRemoteUrl(url: string): string {
  let rest = url.trim();
  rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  rest = rest.replace(/^[^@/]*@/, "");
  // scp-like `host:org/repo`; an explicit port (`host:22/org`) is dropped
  rest = rest.replace(/^([^/:]+):(\d+\/)?/, "$1/");
  rest = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return rest.toLowerCase();
}

export function sameRepository(a: RepositoryReference, b: RepositoryReference): boolean {
  if (a.remoteUrl && b.remoteUrl) return normalizeRemoteUrl(a.remoteUrl) === normalizeRemoteUrl(b.remoteUrl);
  return Boolean(a.gitRoot && b.gitRoot && a.gitRoot === b.gitRoot);
}

export function projectIdFor(repo: RepositoryReference): ProjectId {
  const key = repo.remoteUrl
    ? `remote:${normalizeRemoteUrl(repo.remoteUrl)}`
    : repo.gitRoot
      ? `root:${repo.gitRoot}`
      : repo.localPath
        ? `path:${repo.localPath}`
        : "";
  if (!key) throw new Error("A repository needs a remoteUrl, gitRoot or localPath");
  return asProjectId(`prj_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`);
}
