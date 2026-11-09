import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, projectIdFor, sameRepository } from "./repository.js";

describe("normalizeRemoteUrl", () => {
  it.each([
    "git@GitHub.com:Org/Repo.git",
    "https://github.com/org/repo.git",
    "https://github.com/org/repo/",
    "ssh://git@github.com/org/repo.git",
    "ssh://git@github.com:22/org/repo",
    "https://user:tok@github.com/Org/Repo",
  ])("%s", (url) => {
    expect(normalizeRemoteUrl(url)).toBe("github.com/org/repo");
  });
});

describe("sameRepository", () => {
  it("compares remotes normalized, else git roots", () => {
    expect(sameRepository({ remoteUrl: "git@github.com:a/b.git" }, { remoteUrl: "https://github.com/a/b" })).toBe(true);
    expect(sameRepository({ remoteUrl: "git@github.com:a/b.git" }, { remoteUrl: "https://github.com/a/c" })).toBe(
      false,
    );
    expect(sameRepository({ gitRoot: "/x" }, { gitRoot: "/x" })).toBe(true);
    expect(sameRepository({ gitRoot: "/x" }, { gitRoot: "/y" })).toBe(false);
    expect(sameRepository({ localPath: "/x" }, { localPath: "/x" })).toBe(false);
  });
});

describe("projectIdFor", () => {
  it("is deterministic and prefers remote, then root, then path", () => {
    const a = projectIdFor({ remoteUrl: "git@github.com:a/b.git", gitRoot: "/one" });
    expect(a).toBe(projectIdFor({ remoteUrl: "https://github.com/A/B", gitRoot: "/two" }));
    expect(projectIdFor({ gitRoot: "/r", localPath: "/p" })).toBe(projectIdFor({ gitRoot: "/r" }));
    expect(projectIdFor({ localPath: "/p" })).not.toBe(projectIdFor({ gitRoot: "/p" }));
    expect(() => projectIdFor({})).toThrow();
  });
});
