import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One entry of the composer's `/` list: a command or a skill Claude can run as `/<name>`. */
export interface SlashEntry {
  name: string;
  detail: string;
  /** The plugin it comes from (the part before the colon of `name`); absent for the user's and the project's own. */
  plugin?: string;
}

export interface DiscoverOptions {
  /** The chat's folder: its `.claude/` (skills, commands, settings) and its project-scope plugins. */
  cwd?: string | null;
  home?: string;
  /** Plugin folders the host gives every chat itself (the bundled `squeak` plugin). */
  extraPlugins?: string[];
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDir(p: string): string[] {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
}

/** `name:` and `description:` from front matter, else the first plain line as the description. */
export function frontMatter(file: string): { name?: string; description: string } {
  let text: string;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      text = buf.subarray(0, fs.readSync(fd, buf, 0, 4096, 0)).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { description: "" };
  }
  let lines = text.split("\n").map((l) => l.trim());
  let name: string | undefined;
  let description = "";
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^(name|description):\s*(.*)$/i.exec(l);
        if (!m) continue;
        const v = m[2]!.replace(/^["']|["']$/g, "").trim();
        if (m[1]!.toLowerCase() === "name") {
          if (v) name = v;
        } else if (v && !description) description = v;
      }
      lines = lines.slice(end + 1);
    }
  }
  if (!description) description = (lines.find((l) => l) ?? "").replace(/^[#\s]+/, "").slice(0, 120);
  return { ...(name ? { name } : {}), description: description.slice(0, 240) };
}

function skillEntry(dir: string, prefix: string, plugin?: string): SlashEntry | null {
  const file = path.join(dir, "SKILL.md");
  if (!isFile(file)) return null;
  const fm = frontMatter(file);
  const name = fm.name && !/\s/.test(fm.name) ? fm.name : path.basename(dir);
  return { name: prefix + name, detail: fm.description, ...(plugin ? { plugin } : {}) };
}

/** `<root>/<name>/SKILL.md` for each folder in `root`. */
function skillsIn(root: string, prefix: string, plugin?: string): SlashEntry[] {
  const out: SlashEntry[] = [];
  for (const name of listDir(root)) {
    if (name.startsWith(".")) continue;
    const e = skillEntry(path.join(root, name), prefix, plugin);
    if (e) out.push(e);
  }
  return out;
}

/** `<root>/**.md` as commands; a nested folder is a namespace (`git/pr.md` is `git:pr`). */
function commandsIn(root: string, prefix: string, plugin?: string, depth = 0): SlashEntry[] {
  if (depth > 3) return [];
  const out: SlashEntry[] = [];
  for (const name of listDir(root)) {
    if (name.startsWith(".")) continue;
    const p = path.join(root, name);
    if (isDir(p)) out.push(...commandsIn(p, `${prefix}${name}:`, plugin, depth + 1));
    else if (name.endsWith(".md")) {
      out.push({ name: prefix + name.slice(0, -3), detail: frontMatter(p).description, ...(plugin ? { plugin } : {}) });
    }
  }
  return out;
}

function asList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Where a path of a plugin manifest points, never outside the plugin's own folder. */
function inside(root: string, rel: string): string | null {
  const p = path.resolve(root, rel);
  return p === root || p.startsWith(root + path.sep) ? p : null;
}

/**
 * The skills and commands one plugin folder offers. Its `.claude-plugin/plugin.json` may list `skills` (folders that
 * each hold a SKILL.md, or folders of them) and `commands`; without them `skills/` and `commands/` are read. Names
 * are `<plugin>:<name>`, as Claude Code lists them.
 */
export function pluginEntries(dir: string, fallbackName: string): SlashEntry[] {
  const manifest = readJson(path.join(dir, ".claude-plugin", "plugin.json")) ?? {};
  const plugin = typeof manifest.name === "string" && manifest.name ? manifest.name : fallbackName;
  const prefix = `${plugin}:`;
  const out: SlashEntry[] = [];

  const skillPaths = asList(manifest.skills);
  if (skillPaths.length === 0) out.push(...skillsIn(path.join(dir, "skills"), prefix, plugin));
  for (const rel of skillPaths) {
    const p = inside(dir, rel);
    if (!p) continue;
    const one = skillEntry(p, prefix, plugin);
    if (one) out.push(one);
    else out.push(...skillsIn(p, prefix, plugin));
  }

  const commandPaths = asList(manifest.commands);
  if (commandPaths.length === 0) out.push(...commandsIn(path.join(dir, "commands"), prefix, plugin));
  for (const rel of commandPaths) {
    const p = inside(dir, rel);
    if (!p) continue;
    if (isFile(p) && p.endsWith(".md")) {
      out.push({ name: prefix + path.basename(p).slice(0, -3), detail: frontMatter(p).description, plugin });
    } else out.push(...commandsIn(p, prefix, plugin));
  }
  return out;
}

function enabledPlugins(home: string, cwd: string | null): Map<string, boolean> {
  const files = [path.join(home, ".claude", "settings.json")];
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  const out = new Map<string, boolean>();
  for (const f of files) {
    const e = readJson(f)?.enabledPlugins;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    for (const [k, v] of Object.entries(e)) if (typeof v === "boolean") out.set(k, v);
  }
  return out;
}

/** Install folders of the plugins Claude Code would load for `cwd`: installed, enabled, and in scope. */
export function activePluginDirs(home: string, cwd: string | null): { key: string; dir: string }[] {
  const installed = readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"))?.plugins;
  if (!installed || typeof installed !== "object") return [];
  const enabled = enabledPlugins(home, cwd);
  const out: { key: string; dir: string }[] = [];
  for (const [key, list] of Object.entries(installed as Record<string, unknown>)) {
    if (enabled.get(key) !== true || !Array.isArray(list)) continue;
    for (const raw of list) {
      const r = raw as { scope?: unknown; installPath?: unknown; projectPath?: unknown };
      if (typeof r?.installPath !== "string") continue;
      const scope = r.scope;
      const inScope =
        scope === "user" ||
        ((scope === "project" || scope === "local") &&
          cwd !== null &&
          typeof r.projectPath === "string" &&
          (cwd === r.projectPath || cwd.startsWith(r.projectPath + path.sep)));
      if (inScope && isDir(r.installPath)) {
        out.push({ key, dir: r.installPath });
        break;
      }
    }
  }
  return out;
}

/**
 * Everything the `/` list can offer for a chat in `cwd`, as Claude Code resolves it: the project's and the user's
 * `.claude/commands` and `.claude/skills` (the project's first, hiding a same-named user one), then each enabled
 * plugin's skills and commands as `<plugin>:<name>`. Sorted by name, case-insensitively.
 */
export function discoverSlashEntries(o: DiscoverOptions = {}): SlashEntry[] {
  const home = o.home ?? os.homedir();
  const cwd = o.cwd ? path.resolve(o.cwd) : null;
  const found: SlashEntry[] = [];
  const roots = [...(cwd ? [path.join(cwd, ".claude")] : []), path.join(home, ".claude")];
  for (const root of roots) found.push(...commandsIn(path.join(root, "commands"), ""));
  for (const root of roots) found.push(...skillsIn(path.join(root, "skills"), ""));
  for (const { key, dir } of activePluginDirs(home, cwd)) found.push(...pluginEntries(dir, key.split("@")[0]!));
  for (const dir of o.extraPlugins ?? []) found.push(...pluginEntries(dir, path.basename(dir)));

  const seen = new Set<string>();
  const out: SlashEntry[] = [];
  for (const e of found) {
    if (!e.name || /\s/.test(e.name) || seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
