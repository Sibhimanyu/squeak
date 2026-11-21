import { describe, expect, it } from "vitest";

import type { PhonePond } from "../fleet/native-phone.js";
import type { FleetSession } from "../fleet/types.js";
import { buildPondThreads, onMainFolder } from "./pond-threads.js";

const pond = { id: "p", name: "Shop", shared: false, members: [], folder: "/work/shop", kind: "project" } as PhonePond;
const session = (key: string, over: Partial<FleetSession>): FleetSession =>
  ({
    key,
    state: "idle",
    lastActivityAt: "2026-11-21T10:00:00.000Z",
    cwd: "/work/shop",
    branch: null,
    ...over,
  }) as FleetSession;

describe("buildPondThreads with ducks owning their branch", () => {
  const sessions = [
    session("a", { cwd: "/work/shop-cart", branch: "cart", duckId: "d1" }),
    session("b", { cwd: "/work/shop", branch: "master", duckId: "d2" }),
  ];
  const build = (ducksOwn: boolean) =>
    buildPondThreads(
      pond,
      sessions,
      () => true,
      (s) => s.key,
      () => false,
      [],
      ducksOwn,
    ).streams.flatMap((s) => s.threads);

  it("adds duckId, branch and main to each row only with the flag on", () => {
    const rows = build(true);
    expect(rows.find((r) => r.key === "a")).toMatchObject({ duckId: "d1", branch: "cart" });
    expect(rows.find((r) => r.key === "b")).toMatchObject({ duckId: "d2", main: true });
    expect(rows.find((r) => r.key === "b")?.branch).toBeUndefined();
  });

  it("flag off: rows are exactly as before", () => {
    for (const row of build(false)) expect(Object.keys(row).sort()).toEqual(["at", "key", "state", "title"]);
  });

  it("onMainFolder compares resolved folders", () => {
    expect(onMainFolder("/work/shop/", "/work/shop")).toBe(true);
    expect(onMainFolder("/work/shop-cart", "/work/shop")).toBe(false);
    expect(onMainFolder(null, "/work/shop")).toBe(false);
  });
});
