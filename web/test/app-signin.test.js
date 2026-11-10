import { beforeAll, describe, expect, it } from "vitest";

import { appUrl, parseSigninFragment, PARKED_KEY, readParked, startSignin } from "../js/app-signin.js";
import { chooseEntry } from "../js/entry.js";
import { all, click, installDom, text } from "./fake-dom.js";

beforeAll(installDom);

const STATE = "abcdefghijklmnop0123_-AB";
const vault = (records = {}) => ({ load: async () => records.device ?? null, read: async (k) => records[k] ?? null });
const store = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
};
const rig = ({
  me = { state: "in", user: { email: "pat@x.co", name: "Pat" } },
  hash = "",
  storage = store(),
  now = 1000,
} = {}) => {
  const calls = [];
  const win = {
    location: { hash, pathname: "/app/index.html", search: "", assign: (u) => calls.push(["assign", u]) },
    history: { replaceState: (...a) => calls.push(["replace", a[2]]) },
  };
  const api = {
    me: async () => me,
    linkTicket: async () => "al.t.1.e.m",
    appToken: async () => ({ value: "at.u.1.e.m", user: { email: "pat@x.co", name: "Pat Q" } }),
  };
  const root = {
    children: [],
    replaceChildren(...n) {
      this.children = n;
    },
  };
  const run = (extra = {}) =>
    startSignin({
      root,
      win,
      storage,
      now: () => now,
      api,
      signIn: () => calls.push(["signIn"]),
      signOut: async () => calls.push(["signOut"]),
      ...extra,
    });
  const buttons = () => all(root).filter((n) => n.tag === "button");
  const find = (label) => buttons().find((b) => text(b).includes(label));
  return { calls, win, root, storage, run, find };
};

describe("fragments and routing", () => {
  it("parses both modes and rejects bad states", () => {
    expect(parseSigninFragment(`#mac-signin=${STATE}`)).toEqual({ mode: "mac", state: STATE });
    expect(parseSigninFragment(`#app-signin=${STATE}`)).toEqual({ mode: "app", state: STATE });
    for (const bad of ["short", "x".repeat(65), "has space......12345", "a/b/c/d/e/f/g/h/i/j", ""])
      expect(parseSigninFragment(`#app-signin=${bad}`)).toEqual({ error: "state" });
    expect(parseSigninFragment("#pair=abc")).toBeNull();
    expect(parseSigninFragment("")).toBeNull();
  });

  it("routes a sign-in fragment, and resumes a young parked entry only with no fragment", async () => {
    const empty = store();
    expect(await chooseEntry({ hash: `#mac-signin=${STATE}`, vault: vault(), storage: empty })).toBe("signin");
    expect(await chooseEntry({ hash: "#app-signin=x", vault: vault(), storage: empty })).toBe("signin");
    const parked = store({ [PARKED_KEY]: JSON.stringify({ mode: "app", state: STATE, at: Date.now() - 60_000 }) });
    expect(await chooseEntry({ hash: "", vault: vault({ device: { s: 1 } }), storage: parked })).toBe("signin");
    expect(await chooseEntry({ hash: "#pair=abc", vault: vault(), storage: parked })).toBe("owner");
    const old = store({ [PARKED_KEY]: JSON.stringify({ mode: "app", state: STATE, at: Date.now() - 11 * 60_000 }) });
    expect(await chooseEntry({ hash: "", vault: vault(), storage: old })).toBe("owner");
    expect(readParked(store({ [PARKED_KEY]: "nonsense" }))).toBeNull();
  });
});

describe("the callback page", () => {
  it("signed out: parks the entry, clears the fragment, goes to login", async () => {
    const r = rig({ me: { state: "out" }, hash: `#mac-signin=${STATE}` });
    await r.run();
    expect(r.calls).toEqual([["replace", "/app/index.html"], ["signIn"]]);
    expect(JSON.parse(r.storage.m.get(PARKED_KEY))).toEqual({ mode: "mac", state: STATE, at: 1000 });
  });

  it("resumes the parked entry after login and shows who is signed in, with a button, not a redirect", async () => {
    const storage = store({ [PARKED_KEY]: JSON.stringify({ mode: "app", state: STATE, at: 500 }) });
    const r = rig({ storage });
    await r.run();
    expect(text(r.root.children[0])).toContain("Signed in as Pat (pat@x.co)");
    expect(r.calls.some((c) => c[0] === "assign")).toBe(false);
    expect(r.find("Continue in Squeak")).toBeTruthy();
    expect(r.find("Not you? Sign out")).toBeTruthy();
  });

  it("mac: Continue mints a ticket and opens squeak-mac://", async () => {
    const r = rig({ hash: `#mac-signin=${STATE}` });
    await r.run();
    click(r.find("Continue in Squeak"));
    await new Promise((x) => setTimeout(x, 0));
    expect(r.calls.at(-1)).toEqual(["assign", `squeak-mac://signed-in?ticket=al.t.1.e.m&state=${STATE}`]);
    expect(r.storage.m.has(PARKED_KEY)).toBe(false);
  });

  it("app: Continue mints a token and opens squeak:// with email and name encoded", async () => {
    const r = rig({ hash: `#app-signin=${STATE}` });
    await r.run();
    click(r.find("Continue in Squeak"));
    await new Promise((x) => setTimeout(x, 0));
    expect(r.calls.at(-1)).toEqual([
      "assign",
      `squeak://signed-in?token=at.u.1.e.m&state=${STATE}&email=pat%40x.co&name=Pat%20Q`,
    ]);
    expect(appUrl("app", "t", "s", { email: "a+b@x", name: "é&" })).toBe(
      "squeak://signed-in?token=t&state=s&email=a%2Bb%40x&name=%C3%A9%26",
    );
  });

  it("Not you: parks the state again and signs out", async () => {
    const r = rig({ hash: `#app-signin=${STATE}` });
    await r.run();
    click(r.find("Not you? Sign out"));
    await new Promise((x) => setTimeout(x, 0));
    expect(r.calls.at(-1)).toEqual(["signOut"]);
    expect(JSON.parse(r.storage.m.get(PARKED_KEY)).state).toBe(STATE);
  });

  it("a bad state shows an error and never calls the relay or the login", async () => {
    const r = rig({ hash: "#app-signin=short" });
    await r.run();
    expect(text(r.root.children[0])).toContain("not complete");
    expect(r.calls).toEqual([["replace", "/app/index.html"]]);
  });

  it("says plainly when the server cannot be reached or a call fails", async () => {
    const down = rig({ me: { state: "unknown" }, hash: `#mac-signin=${STATE}` });
    await down.run();
    expect(text(down.root.children[0])).toContain("Could not reach");
    const bad = rig({ hash: `#mac-signin=${STATE}` });
    await bad.run({
      api: {
        me: async () => ({ state: "in", user: { email: "e", name: "" } }),
        linkTicket: async () => {
          throw Object.assign(new Error("x"), { status: 401 });
        },
      },
    });
    click(bad.find("Continue in Squeak"));
    await new Promise((x) => setTimeout(x, 0));
    expect(text(bad.root.children[0])).toContain("sign-in ran out");
    expect(bad.calls.some((c) => c[0] === "assign")).toBe(false);
  });
});
