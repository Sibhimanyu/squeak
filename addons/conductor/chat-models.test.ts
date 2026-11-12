import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { listChatModels } from "./chat-models.js";
import { modelLabel } from "../../src/fleet/model-labels.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function conductor(favorites: unknown[], picker: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-models-"));
  dirs.push(dir);
  const dbPath = path.join(dir, "conductor.db");
  const db = new Database(dbPath);
  db.exec(
    "CREATE TABLE favorite_models (organization_id TEXT, user_id TEXT, id TEXT, position INTEGER, configuration TEXT, created_at TEXT)",
  );
  favorites.forEach((config, i) =>
    db.prepare("INSERT INTO favorite_models (position, configuration) VALUES (?, ?)").run(i, JSON.stringify(config)),
  );
  db.close();
  fs.writeFileSync(
    path.join(dir, "local-storage.subsystem.model-picker-configs-v1.json"),
    JSON.stringify(Object.fromEntries(Object.entries(picker).map(([k, v]) => [k, JSON.stringify(v)]))),
  );
  return dbPath;
}

describe("modelLabel", () => {
  it("reads Conductor's aliases as people say them", () => {
    expect(modelLabel("opus-5-5-1m")).toBe("Opus 5.5 · 1M");
    expect(modelLabel("sonnet-5-1m")).toBe("Sonnet 5 · 1M");
    expect(modelLabel("haiku-4-5")).toBe("Haiku 4.5");
    expect(modelLabel("gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(modelLabel("gpt-6-sol")).toBe("GPT 6 Sol");
    expect(modelLabel("fable-5-1")).toBe("Fable 5.1");
  });
});

describe("listChatModels", () => {
  it("lists the favourites first, then the other models Conductor has settings for", () => {
    const db = conductor(
      [
        { type: "built-in", agent: "claude", model: "sonnet-5-5-1m", thinkingLevel: "medium" },
        { type: "built-in", agent: "codex", model: "gpt-6.1-sol", thinkingLevel: "high" },
        { type: "acp", agent: "acp", model: "opencode:x" },
      ],
      {
        "opus-5-5-1m": { effortLevel: "medium", fastMode: false },
        "sonnet-5-5-1m": { effortLevel: "medium", fastMode: false },
        "gpt-6.1-sol": { effortLevel: "high", fastMode: false },
        "haiku-4-5": { fastMode: false },
      },
    );
    const models = listChatModels(db);
    expect(models.map((m) => [m.id, m.favorite])).toEqual([
      ["sonnet-5-5-1m", true],
      ["gpt-6.1-sol", true],
      ["opus-5-5-1m", false],
      ["haiku-4-5", false],
    ]);
    expect(models[1]).toMatchObject({ agent: "codex", label: "GPT 6.1 Sol", defaultLevel: "high" });
    expect(models[1]!.levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(models[0]!.levels).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // A model whose settings carry no effort takes no thinking level.
    expect(models[3]).toMatchObject({ agent: "claude", levels: [] });
    expect(models[3]!.defaultLevel).toBeUndefined();
  });

  it("works with no settings file and ignores aliases that are not plain", () => {
    const db = conductor(
      [
        { type: "built-in", agent: "claude", model: "opus-5-1m" },
        { type: "built-in", agent: "claude", model: "bad alias; drop" },
      ],
      {},
    );
    fs.rmSync(path.join(path.dirname(db), "local-storage.subsystem.model-picker-configs-v1.json"));
    expect(listChatModels(db).map((m) => m.id)).toEqual(["opus-5-1m"]);
  });
});

describe("listChatModels without Conductor", () => {
  it("falls back to Squeak's built-in catalog when conductor.db is absent or unreadable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-models-none-"));
    dirs.push(dir);
    const absent = listChatModels(path.join(dir, "conductor.db"));
    expect(absent.length).toBeGreaterThan(3);
    expect(absent.find((m) => m.id === "opus-5-5-1m")).toMatchObject({
      agent: "claude",
      favorite: true,
      defaultLevel: "medium",
    });
    expect(absent.find((m) => m.agent === "codex")!.levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(absent.find((m) => m.id === "haiku-4-5")!.levels).toEqual([]);
    const bad = path.join(dir, "bad.db");
    fs.writeFileSync(bad, "not a database at all, just text");
    expect(listChatModels(bad).map((m) => m.id)).toEqual(absent.map((m) => m.id));
  });

  it("still reads Conductor's own list when its database is there", () => {
    const db = conductor([{ type: "built-in", agent: "claude", model: "opus-5-1m" }], {});
    expect(listChatModels(db).map((m) => m.id)).toEqual(["opus-5-1m"]);
  });
});
