// Maps a request URL onto a file under `root`, or returns null. Malformed
// percent-encoding, NUL bytes, and any path that leaves `root` are refused.
import { join, resolve, sep } from "node:path";

export function containedPath(root: string, requestUrl: string, prefix = ""): string | null {
  const rootPath = resolve(root);
  const rawPath = requestUrl.split("?")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  if (prefix && (decoded === prefix || decoded.startsWith(`${prefix}/`))) {
    decoded = decoded.slice(prefix.length) || "/";
  }
  const target = resolve(rootPath, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (target !== rootPath && !target.startsWith(rootPath + sep)) return null;
  return target === rootPath ? join(rootPath, "index.html") : target;
}
