import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverSlashEntries } from "./slash-commands.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "slash-"));
  dirs.push(d);
  return d;
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function skill(dir: string, description: string, name?: string): void {
  write(path.join(dir, "SKILL.md"), `---\n${name ? `name: ${name}\n` : ""}description: ${description}\n---\nBody\n`);
}

/** A HOME with the Matt Pocock plugin installed at user scope, as the owner has it. */
function homeWithPlugins() {
  const home = tmp();
  const install = path.join(home, ".claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1");
  write(
    path.join(install, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "mattpocock-skills",
      skills: ["./skills/productivity/grilling", "./skills/engineering/tdd"],
    }),
  );
  skill(path.join(install, "skills/productivity/grilling"), "Grill the user");
  skill(path.join(install, "skills/engineering/tdd"), "Test first");
  // Not listed by the manifest, so not offered (as in Claude Code).
  skill(path.join(install, "skills/in-progress/loop-me"), "Unlisted");
  // A plugin with no manifest lists: skills/ and commands/ are read.
  const plain = path.join(home, ".claude/plugins/cache/m/plain/1.0.0");
  write(path.join(plain, ".claude-plugin/plugin.json"), JSON.stringify({ name: "plain" }));
  skill(path.join(plain, "skills/one"), "One");
  write(path.join(plain, "commands/go.md"), "---\ndescription: Go now\n---\n");
  write(
    path.join(home, ".claude/plugins/installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "mattpocock-skills@claude-plugins-official": [{ scope: "user", installPath: install, version: "1.3.1" }],
        "plain@m": [{ scope: "user", installPath: plain }],
        "off@m": [{ scope: "user", installPath: plain }],
        "proj@m": [{ scope: "project", installPath: plain, projectPath: "/not/here" }],
      },
    }),
  );
  write(
    path.join(home, ".claude/settings.json"),
    JSON.stringify({
      enabledPlugins: {
        "mattpocock-skills@claude-plugins-official": true,
        "plain@m": true,
        "off@m": false,
        "proj@m": true,
      },
    }),
  );
  return home;
}

describe("discoverSlashEntries", () => {
  it("lists an enabled user plugin's skills as plugin:skill, so /matt can find them", () => {
    const home = homeWithPlugins();
    const names = discoverSlashEntries({ home }).map((e) => e.name);
    expect(names).toContain("mattpocock-skills:grilling");
    expect(names).toContain("mattpocock-skills:tdd");
    expect(names).not.toContain("mattpocock-skills:loop-me");
    const grilling = discoverSlashEntries({ home }).find((e) => e.name === "mattpocock-skills:grilling");
    expect(grilling).toMatchObject({ plugin: "mattpocock-skills", detail: "Grill the user" });
  });

  it("reads skills/ and commands/ of a plugin with no lists, and skips disabled and out-of-scope plugins", () => {
    const home = homeWithPlugins();
    const names = discoverSlashEntries({ home, cwd: path.join(home, "work") }).map((e) => e.name);
    expect(names).toContain("plain:one");
    expect(names).toContain("plain:go");
    expect(names.filter((n) => n.startsWith("off:"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("proj:"))).toEqual([]);
  });

  it("offers a project-scope plugin in its own project only, and honours the project's settings", () => {
    const home = homeWithPlugins();
    const project = path.join(home, "app");
    const plugin = path.join(home, ".claude/plugins/cache/m/plain/1.0.0");
    write(
      path.join(home, ".claude/plugins/installed_plugins.json"),
      JSON.stringify({ plugins: { "proj@m": [{ scope: "project", installPath: plugin, projectPath: project }] } }),
    );
    write(path.join(project, ".claude/settings.json"), JSON.stringify({ enabledPlugins: { "proj@m": true } }));
    expect(discoverSlashEntries({ home, cwd: project }).map((e) => e.name)).toContain("plain:one");
    expect(discoverSlashEntries({ home, cwd: path.join(home, "other") }).map((e) => e.name)).not.toContain("plain:one");
    write(path.join(project, ".claude/settings.local.json"), JSON.stringify({ enabledPlugins: { "proj@m": false } }));
    expect(discoverSlashEntries({ home, cwd: project }).map((e) => e.name)).not.toContain("plain:one");
  });

  it("includes the user's and the project's own skills and commands, the project hiding a user one", () => {
    const home = homeWithPlugins();
    const project = path.join(home, "app");
    skill(path.join(home, ".claude/skills/review"), "User review");
    skill(path.join(project, ".claude/skills/review"), "Project review");
    skill(path.join(project, ".claude/skills/ship"), "Ship it", "ship-it");
    write(path.join(project, ".claude/commands/git/pr.md"), "# Open a PR\n");
    const all = discoverSlashEntries({ home, cwd: project });
    expect(all.find((e) => e.name === "review")?.detail).toBe("Project review");
    expect(all.map((e) => e.name)).toEqual(expect.arrayContaining(["ship-it", "git:pr"]));
    expect(all.find((e) => e.name === "git:pr")?.detail).toBe("Open a PR");
  });

  it("adds the bundled plugins and sorts case-insensitively", () => {
    const home = tmp();
    const bundled = path.join(home, "agent-plugin");
    write(path.join(bundled, ".claude-plugin/plugin.json"), JSON.stringify({ name: "squeak" }));
    skill(path.join(bundled, "skills/squeak"), "Squeak");
    skill(path.join(home, ".claude/skills/Zed"), "z");
    skill(path.join(home, ".claude/skills/alpha"), "a");
    expect(discoverSlashEntries({ home, extraPlugins: [bundled] }).map((e) => e.name)).toEqual([
      "alpha",
      "squeak:squeak",
      "Zed",
    ]);
  });

  it("is empty, not an error, with no .claude folder or a broken installed_plugins.json", () => {
    const home = tmp();
    expect(discoverSlashEntries({ home })).toEqual([]);
    write(path.join(home, ".claude/plugins/installed_plugins.json"), "{nope");
    expect(discoverSlashEntries({ home })).toEqual([]);
  });
});
