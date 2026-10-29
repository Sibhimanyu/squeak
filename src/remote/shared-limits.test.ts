import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ChannelDoc } from "./firestore-rest.js";
import type { ChannelStore } from "./remote-bridge.js";
import { BudgetedStore, CloudBudget } from "./shared-limits.js";

describe("CloudBudget", () => {
  it("counts bytes, pauses until local midnight and resets the next day", () => {
    let now = new Date(2026, 9, 29, 10, 0, 0).getTime();
    const budget = new CloudBudget(100, () => now);
    budget.add(60);
    expect(budget.exceeded()).toBe(false);
    expect(budget.pausedUntil).toBeNull();
    budget.add(40);
    expect(budget.exceeded()).toBe(true);
    expect(budget.pausedUntil).toBe(new Date(2026, 9, 30).getTime());
    expect(budget.announceOnce()).toBe(true);
    expect(budget.announceOnce()).toBe(false);
    now = new Date(2026, 9, 30, 0, 0, 1).getTime();
    expect(budget.exceeded()).toBe(false);
    expect(budget.usedBytes).toBe(0);
  });

  it("defaults to 20 MB", () => {
    expect(new CloudBudget().budgetBytes).toBe(20 * 1024 * 1024);
  });
});

describe("CloudBudget persistence", () => {
  it("survives a restart on the same day, saves at most every 30 s and on flush, and drops a past day", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-budget-"));
    const file = path.join(dir, "shared-budget.json");
    let now = new Date(2026, 9, 29, 10, 0, 0).getTime();
    const first = new CloudBudget(100, () => now, file);
    first.add(10);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).usedBytes).toBe(10);
    first.add(5);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).usedBytes).toBe(10);
    now += 30_000;
    first.add(1);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).usedBytes).toBe(16);
    first.add(4);
    first.flush();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new CloudBudget(100, () => now, file).usedBytes).toBe(20);
    now = new Date(2026, 9, 30, 9, 0, 0).getTime();
    expect(new CloudBudget(100, () => now, file).usedBytes).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("BudgetedStore", () => {
  function inner() {
    const calls: string[] = [];
    const store: ChannelStore = {
      async get() {
        calls.push("get");
        return { box: "x".repeat(30) } as ChannelDoc;
      },
      async list() {
        calls.push("list");
        return [{ id: "a", doc: { box: "y".repeat(30) } as ChannelDoc }];
      },
      async set() {
        calls.push("set");
      },
      async delete() {
        calls.push("delete");
      },
    };
    return { store, calls };
  }

  it("counts reads and writes, then stops touching the cloud", async () => {
    const { store, calls } = inner();
    const budget = new CloudBudget(100, () => 1_000_000);
    const budgeted = new BudgetedStore(store, budget);
    await budgeted.get("p");
    await budgeted.list("c");
    await budgeted.set("p", { box: "z".repeat(40) } as ChannelDoc);
    expect(budget.usedBytes).toBe(100);
    expect(budget.exceeded()).toBe(true);
    expect(await budgeted.get("p")).toBeNull();
    expect(await budgeted.list("c")).toEqual([]);
    await budgeted.set("p", { box: "q" } as ChannelDoc);
    await budgeted.delete("p");
    expect(calls).toEqual(["get", "list", "set"]);
  });
});
