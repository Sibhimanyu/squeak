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
