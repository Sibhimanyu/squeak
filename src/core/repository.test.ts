import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl } from "./repository.js";

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
