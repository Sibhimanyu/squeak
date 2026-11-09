import { describe, expect, it } from "vitest";
import { readRepositoryReference } from "./git-identity.js";
import { inferProject } from "./project-inference.js";

const fake = (remote: string, root: string) => (_cmd: string, args: string[]) => {
  if (args.includes("get-url")) return remote + "\n";
  if (args.includes("--show-toplevel")) return root;
  throw new Error("unexpected");
};

describe("readRepositoryReference", () => {
  it("reads remote and root", async () => {
    expect(await readRepositoryReference("/w/a", fake("git@h:o/r.git", "/w/a"))).toEqual({
      localPath: "/w/a",
      remoteUrl: "git@h:o/r.git",
      gitRoot: "/w/a",
    });
  });
  it("never throws; failures leave fields undefined", async () => {
    const ref = await readRepositoryReference("/nope", () => {
      throw new Error("not a repo");
    });
    expect(ref).toEqual({ localPath: "/nope" });
    const rejected = await readRepositoryReference("/nope", () => Promise.reject(new Error("x")));
    expect(rejected.remoteUrl).toBeUndefined();
  });
  it("two worktrees of one repo share a project", async () => {
    const a = await readRepositoryReference("/wt/one", fake("git@h:o/r.git", "/wt/one"));
    const b = await readRepositoryReference("/wt/two", fake("https://h/o/r", "/wt/two"));
    expect(inferProject({ repo: a }).projectId).toBe(inferProject({ repo: b }).projectId);
  });
});
