import { describe, expect, it } from "vitest";
import { IMPORTED_PROJECT_ID, inferProject } from "./project-inference.js";

describe("inferProject", () => {
  it("prefers the normalized remote", () => {
    const a = inferProject({ repo: { remoteUrl: "git@github.com:Org/Repo.git", gitRoot: "/a/repo" } });
    const b = inferProject({ repo: { remoteUrl: "https://github.com/org/repo", gitRoot: "/b/repo-wt" } });
    expect(a.inferredFrom).toBe("remote");
    expect(a.projectId).toBe(b.projectId);
    expect(a.name).toBe("repo");
  });
  it("keeps different remotes apart", () => {
    const a = inferProject({ repo: { remoteUrl: "git@github.com:org/one.git" } });
    const b = inferProject({ repo: { remoteUrl: "git@github.com:org/two.git" } });
    expect(a.projectId).not.toBe(b.projectId);
  });
  it("falls back to gitRoot, localPath, then imported", () => {
    expect(inferProject({ repo: { gitRoot: "/w/app", localPath: "/w/app/sub" } }).inferredFrom).toBe("gitRoot");
    const p = inferProject({ path: "/w/tool" });
    expect(p.inferredFrom).toBe("localPath");
    expect(p.name).toBe("tool");
    const i = inferProject({});
    expect(i).toMatchObject({ projectId: IMPORTED_PROJECT_ID, name: "Imported Sessions", inferredFrom: "imported" });
  });
  it("is deterministic", () => {
    expect(inferProject({ path: "/x/y" })).toEqual(inferProject({ path: "/x/y" }));
  });
});
