import { describe, expect, it } from "vitest";
import { createAuth, UNREACHABLE_MESSAGE, type AuthState } from "../src/auth/auth.js";
import { handoffUrl, readToken, takeHandoffToken } from "../src/auth/session.js";
import { createRelay } from "../src/relay/client.js";
import { createFakeRelay } from "../src/relay/fake.js";
import { ASHA, CONFIG, FAR_FUTURE, memoryStore, storedToken, TOKEN } from "./helpers.js";

const setup = (stored: Record<string, string>, relay: Parameters<typeof createFakeRelay>[0] = {}) => {
  const fake = createFakeRelay({ accounts: { [TOKEN]: ASHA }, ...relay });
  const storage = memoryStore(stored);
  const visited: string[] = [];
  const auth = createAuth({
    config: CONFIG,
    relay: createRelay(CONFIG.relayBase, fake.fetch),
    storage,
    navigate: (url) => visited.push(url),
  });
  const seen: AuthState["status"][] = [];
  auth.subscribe((s) => seen.push(s.status));
  return { auth, fake, storage, visited, seen };
};

describe("sign-in flow", () => {
  it("is signed out with no kept token and asks the network nothing", async () => {
    const { auth, fake } = setup({});
    await auth.start();
    expect(auth.state()).toEqual({ status: "signed-out" });
    expect(fake.state.requests).toHaveLength(0);
  });

  it("signs in with a kept token, sent as x-squeak-account with no cookie", async () => {
    const { auth, fake, seen } = setup(storedToken());
    await auth.start();
    expect(auth.state()).toEqual({ status: "signed-in", account: ASHA, token: TOKEN });
    expect(seen).toEqual(["checking", "signed-in"]);
    expect(fake.state.requests.map((r) => [r.url, r.account, r.credentials])).toEqual([
      [`${CONFIG.relayBase}/me`, TOKEN, "omit"],
    ]);
  });

  it("forgets a token the relay refuses (401) and is signed out, not failed", async () => {
    const { auth, storage } = setup(storedToken(), { accounts: {} });
    await auth.start();
    expect(auth.state()).toEqual({ status: "signed-out" });
    expect(readToken(storage)).toBeNull();
  });

  it("treats an expired token as none", async () => {
    const { auth, fake } = setup(storedToken(1000));
    await auth.start();
    expect(auth.state().status).toBe("signed-out");
    expect(fake.state.requests).toHaveLength(0);
  });

  it.each(["down", "broken"] as const)(
    "a relay that is %s is one sentence and Try again, keeping the token",
    async (mode) => {
      const { auth, fake, storage } = setup(storedToken(), { mode });
      await auth.start();
      expect(auth.state()).toEqual({ status: "failed", message: UNREACHABLE_MESSAGE });
      expect(readToken(storage)).toBe(TOKEN);
      // Try again is start() again, and a relay that is back signs in.
      fake.state.mode = "up";
      await auth.start();
      expect(auth.state().status).toBe("signed-in");
    },
  );

  it("an older answer never overwrites a newer one", async () => {
    const { auth, fake } = setup(storedToken());
    const first = auth.start();
    fake.state.accounts = {};
    const second = auth.start();
    await Promise.all([first, second]);
    expect(auth.state().status).toBe("signed-out");
  });

  it("Continue with a provider remembers where you were and goes to hosted login", () => {
    const { auth, storage, visited } = setup({});
    auth.signIn("google", "/join/K7P4QD");
    expect(storage.data.get("squeak-return-to")).toBe("/join/K7P4QD");
    expect(visited).toEqual([handoffUrl(CONFIG, "google")]);
    const url = new URL(visited[0] ?? "");
    expect(url.origin + url.pathname).toBe(`${CONFIG.relayBase}/account/handoff`);
    expect(url.searchParams.get("return")).toBe("https://app.example.test/");
  });

  it("refuses a return target that is not an in-app path", () => {
    const { auth, storage } = setup({});
    auth.signIn("zoho", "https://evil.example/");
    expect(storage.data.has("squeak-return-to")).toBe(false);
  });

  it("sign out forgets the token", async () => {
    const { auth, storage } = setup(storedToken());
    await auth.start();
    auth.signOut();
    expect(auth.state().status).toBe("signed-out");
    expect(readToken(storage)).toBeNull();
  });
});

describe("handoff token", () => {
  it("is kept from the address fragment and ignored when malformed", () => {
    const store = memoryStore();
    expect(takeHandoffToken("#squeak-token=bad&exp=1", store)).toBe(false);
    expect(takeHandoffToken(`#squeak-token=${TOKEN}&exp=${FAR_FUTURE}`, store)).toBe(true);
    expect(readToken(store)).toBe(TOKEN);
  });
});
