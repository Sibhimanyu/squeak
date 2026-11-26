import { describe, expect, it } from "vitest";
import { prepareAddress } from "../src/boot.js";
import { createRouter, parentRoute, parsePath, routePath, type Route, type RouterWindow } from "../src/router.js";
import { memoryStore, TOKEN, FAR_FUTURE } from "./helpers.js";

const fakeWindow = (hash = "", pathname = "/"): RouterWindow & { fire(): void; history: { log: string[] } } => {
  const listeners = new Set<() => void>();
  const log: string[] = [];
  const win = {
    location: { hash, pathname, search: "" },
    history: {
      log,
      pushState: (_s: unknown, _t: string, url: string) => {
        win.location.hash = url.slice(url.indexOf("#"));
        log.push(`push ${url}`);
      },
      replaceState: (_s: unknown, _t: string, url: string) => {
        win.location.hash = url.slice(url.indexOf("#"));
        log.push(`replace ${url}`);
      },
    },
    addEventListener: (_: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_: string, l: () => void) => void listeners.delete(l),
    fire: () => listeners.forEach((l) => l()),
  };
  return win as never;
};

describe("router skeleton: Ponds, Pond (Room | Ducks), Duck", () => {
  it("parses every screen and falls back to the Pond list for anything else", () => {
    expect(parsePath("/ponds")).toEqual({ name: "ponds" });
    expect(parsePath("/ponds/p1")).toEqual({ name: "pond", pondId: "p1", tab: "room" });
    expect(parsePath("/ponds/p1/room")).toEqual({ name: "pond", pondId: "p1", tab: "room" });
    expect(parsePath("/ponds/p1/ducks")).toEqual({ name: "pond", pondId: "p1", tab: "ducks" });
    expect(parsePath("/ponds/p1/ducks/d9")).toEqual({ name: "duck", pondId: "p1", duckId: "d9" });
    expect(parsePath("/join/K7P4QD")).toEqual({ name: "join", code: "K7P4QD" });
    for (const odd of ["", "/", "/nope", "/ponds/p1/ducks/d9/x", "/ponds/p 1", "/join"]) {
      expect(parsePath(odd)).toEqual({ name: "ponds" });
    }
  });

  it("formats and parses back to the same route", () => {
    const routes: Route[] = [
      { name: "ponds" },
      { name: "pond", pondId: "p1", tab: "room" },
      { name: "pond", pondId: "p1", tab: "ducks" },
      { name: "duck", pondId: "p1", duckId: "d9" },
      { name: "join", code: "AB-12" },
    ];
    for (const r of routes) expect(parsePath(routePath(r))).toEqual(r);
  });

  it("Back goes Duck, then the Pond's Ducks, then Ponds", () => {
    const duck: Route = { name: "duck", pondId: "p1", duckId: "d9" };
    const pond = parentRoute(duck);
    expect(pond).toEqual({ name: "pond", pondId: "p1", tab: "ducks" });
    expect(parentRoute(pond!)).toEqual({ name: "ponds" });
    expect(parentRoute({ name: "ponds" })).toBeNull();
  });

  it("go() writes the hash and tells subscribers; hashchange does too", () => {
    const win = fakeWindow("#/ponds");
    const router = createRouter(win);
    const seen: Route[] = [];
    const off = router.subscribe((r) => seen.push(r));
    router.go({ name: "pond", pondId: "p1", tab: "ducks" });
    expect(win.history.log).toEqual(["push /#/ponds/p1/ducks"]);
    win.location.hash = "#/ponds/p1/ducks/d2";
    win.fire();
    expect(seen).toEqual([
      { name: "pond", pondId: "p1", tab: "ducks" },
      { name: "duck", pondId: "p1", duckId: "d2" },
    ]);
    off();
    win.fire();
    expect(seen).toHaveLength(2);
  });

  it("go() can replace instead of push", () => {
    const win = fakeWindow();
    createRouter(win).go({ name: "ponds" }, { replace: true });
    expect(win.history.log).toEqual(["replace /#/ponds"]);
  });
});

describe("prepareAddress", () => {
  it("opens an emailed invite link (/join#code) as the join route", () => {
    const win = fakeWindow("#K7P4QD", "/join");
    expect(prepareAddress(win, memoryStore())).toEqual({ name: "join", code: "K7P4QD" });
    expect(win.history.log).toEqual(["replace /#/join/K7P4QD"]);
  });

  it("refuses a join code that is not a plain id", () => {
    expect(prepareAddress(fakeWindow("#a/b", "/join"), memoryStore())).toEqual({ name: "ponds" });
  });

  it("back from hosted login: keeps the token, clears the fragment and returns to where you were", () => {
    const store = memoryStore({ "squeak-return-to": "/ponds/p1/ducks/d9" });
    const win = fakeWindow(`#squeak-token=${TOKEN}&exp=${FAR_FUTURE}`);
    expect(prepareAddress(win, store)).toEqual({ name: "duck", pondId: "p1", duckId: "d9" });
    expect(win.location.hash).toBe("#/ponds/p1/ducks/d9");
    expect(store.getItem("squeak-account-token")).toContain(TOKEN);
    expect(store.getItem("squeak-return-to")).toBeNull();
  });

  it("back from hosted login with nowhere remembered lands on the Pond list", () => {
    const win = fakeWindow(`#squeak-token=${TOKEN}&exp=${FAR_FUTURE}`);
    expect(prepareAddress(win, memoryStore())).toEqual({ name: "ponds" });
  });

  it("leaves an ordinary in-app address alone", () => {
    const win = fakeWindow("#/ponds/p1/ducks");
    expect(prepareAddress(win, memoryStore())).toEqual({ name: "pond", pondId: "p1", tab: "ducks" });
    expect(win.history.log).toEqual([]);
  });
});
