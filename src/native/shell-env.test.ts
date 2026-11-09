import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { adoptLoginShellPath, mergePath, readLoginShellPath } from "./shell-env.js";

describe("shell PATH", () => {
  it("puts the shell's entries first, keeps the old ones and adds the usual places once", () => {
    expect(mergePath("/a:/b:/usr/bin", "/usr/bin:/bin", "/h")).toBe(
      "/a:/b:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/h/.local/bin",
    );
    expect(mergePath(null, undefined, "/h").split(":")).toContain("/opt/homebrew/bin");
  });

  it("reads PATH from a login shell, ignoring what the shell prints around it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-env-"));
    const shell = path.join(dir, "fake-shell");
    // A shell whose rc files print noise, then runs the command with its own PATH.
    fs.writeFileSync(shell, '#!/bin/sh\necho "welcome!"\nPATH=/from/rc:/usr/bin\nexport PATH\neval "$2"\necho bye\n', {
      mode: 0o755,
    });
    expect(readLoginShellPath(shell)).toBe("/from/rc:/usr/bin");
  });

  it("falls back when the shell fails or hangs", () => {
    expect(readLoginShellPath("/nonexistent/shell")).toBeNull();
    const env: NodeJS.ProcessEnv = { SHELL: "/nonexistent/shell", PATH: "/usr/bin:/bin" };
    expect(adoptLoginShellPath(env)).toBe("fallback");
    expect(env.PATH!.startsWith("/usr/bin:/bin:")).toBe(true);
    expect(env.PATH).toContain("/opt/homebrew/bin");
  });
});
