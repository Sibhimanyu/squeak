import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClipStore } from "./clip-store.js";

const dirs: string[] = [];
const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-store-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ClipStore", () => {
  it("gives back what was saved, after a restart", () => {
    const dir = path.join(temp(), "clips");
    new ClipStore(dir).save([{ text: "Hello, this is Squeak.", mulaw: "AAEC" }]);
    expect(new ClipStore(dir).load()).toEqual([{ text: "Hello, this is Squeak.", mulaw: "AAEC" }]);
  });

  it("keeps one file per text, the newest recording", () => {
    const store = new ClipStore(temp());
    store.save([{ text: "Goodbye.", mulaw: "AAAA" }]);
    store.save([{ text: "Goodbye.", mulaw: "BBBB" }]);
    expect(store.load()).toEqual([{ text: "Goodbye.", mulaw: "BBBB" }]);
  });

  it("drops the oldest past the limit and skips torn files", () => {
    const dir = temp();
    const store = new ClipStore(dir, 2);
    for (const [i, text] of ["a", "b", "c"].entries()) {
      store.save([{ text, mulaw: "AAAA" }]);
      const newest = fs
        .readdirSync(dir)
        .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
        .sort((x, y) => y.at - x.at)[0]!;
      fs.utimesSync(path.join(dir, newest.name), 1000 + i, 1000 + i);
    }
    fs.writeFileSync(path.join(dir, "torn.json"), "{not json");
    expect(
      store
        .load()
        .map((clip) => clip.text)
        .sort(),
    ).toEqual(["b", "c"]);
  });

  it("never throws when it cannot write", () => {
    const blocked = path.join(temp(), "file");
    fs.writeFileSync(blocked, "x");
    expect(() => new ClipStore(path.join(blocked, "clips")).save([{ text: "x", mulaw: "AAAA" }])).not.toThrow();
    expect(new ClipStore(path.join(blocked, "clips")).load()).toEqual([]);
  });
});
