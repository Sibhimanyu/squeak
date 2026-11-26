// @vitest-environment jsdom
// The invite page (issue #132), through the real App over a fake relay: the welcome, Join in your browser, Not for me, the Mac button
// on a Mac only, every state with its one sentence, the wrong address, and the one-time Mac card after joining.
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { InvitePreview } from "../../src/shared/shapes.js";
import { App } from "../src/app.js";
import { MAC_CARD_KEY } from "../src/app.js";
import { createAuth } from "../src/auth/auth.js";
import { createMemoryVault } from "../src/device/vault.js";
import { isMac, MAC_DOWNLOAD_URL } from "../src/platform.js";
import { createRelay } from "../src/relay/client.js";
import { createFakeRelay, type FakeRelayState } from "../src/relay/fake.js";
import { createRouter } from "../src/router.js";
import { ASHA, CONFIG, memoryStore, storedToken, TOKEN } from "./helpers.js";
import { settle, until } from "./harness.js";

const INVITE: InvitePreview = {
  inviter: "Sibhi",
  pond: "greenroom",
  members: ["Sibhi", "Asha", "Dev"],
  state: "pending",
  masked: "a***@f***.dev",
  expiresAt: Date.UTC(2026, 11, 3, 12),
};

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
  window.location.hash = "";
});

const boot = async (
  o: { signedIn?: boolean; mac?: boolean; invite?: Partial<InvitePreview>; relay?: Partial<FakeRelayState> } = {},
) => {
  window.location.hash = "#/invite/K7P4QD";
  const fake = createFakeRelay({
    accounts: { [TOKEN]: ASHA },
    invites: { K7P4QD: { ...INVITE, ...o.invite } },
    overviews: {
      [TOKEN]: {
        ponds: [],
        invitations: [{ inviteId: "K7P4QD", pondName: "greenroom", inviterName: "Sibhi", at: Date.now() }],
      },
    },
    ...o.relay,
  });
  const relay = createRelay(CONFIG.relayBase, fake.fetch);
  const visited: string[] = [];
  const storage = memoryStore(o.signedIn ? storedToken() : {});
  const seen = memoryStore();
  const auth = createAuth({ config: CONFIG, relay, storage, navigate: (u) => visited.push(u) });
  root = document.createElement("div");
  document.body.append(root);
  act(() =>
    render(
      <App
        auth={auth}
        relay={relay}
        router={createRouter(window)}
        vault={createMemoryVault()}
        seen={seen}
        mac={o.mac ?? false}
      />,
      root,
    ),
  );
  await until(() => root.querySelector(".hero") || root.querySelector("[data-invite=missing]"), "the invite page");
  return { fake, visited, storage, seen };
};

const labels = () => [...root.querySelectorAll("button, a.button")].map((b) => b.textContent?.trim());
const click = (text: string): void => {
  const el = [...root.querySelectorAll<HTMLElement>("button, a")].find((b) => b.textContent?.trim() === text);
  if (!el) throw new Error(`no "${text}"; have ${labels().join(" | ")}`);
  act(() => el.click());
};
const text = () => root.textContent ?? "";

describe("the invite page, signed out", () => {
  it("welcomes by name: who invited, the Pond, who is in it, one primary button, the three-part story", async () => {
    await boot();
    expect(root.querySelector("h1")?.textContent).toBe("Sibhi invited you to greenroom");
    expect(root.querySelector(".pond-name")?.textContent).toBe("greenroom");
    expect(root.querySelector(".members")?.textContent).toContain("Sibhi, Asha and Dev are in greenroom");
    expect(root.querySelectorAll(".hero .members .avatar")).toHaveLength(3);
    expect(root.querySelector(".hero .button.solid")?.textContent).toBe("Join in your browser");
    expect(text()).toContain("An invitation for a***@f***.dev");
    expect([...root.querySelectorAll(".part .kicker")].map((e) => e.textContent)).toEqual([
      "1 · The Room",
      "2 · Ducks",
      "3 · The Pond",
    ]);
    expect(root.querySelectorAll(".part img.shot")).toHaveLength(3);
    expect(text()).toContain("This invitation was sent to a***@f***.dev and expires 3 Dec");
    expect(text()).toContain("Nothing to install");
    expect(root.querySelector(".closing")).not.toBeNull();
  });

  it("never shows the full address", async () => {
    await boot();
    expect(root.innerHTML).not.toContain("asha@fernlabs.dev");
  });

  it("Get Squeak for Mac appears on a Mac only, linking the website, with the masked address", async () => {
    await boot({ mac: true });
    const get = [...root.querySelectorAll<HTMLAnchorElement>("a.button")].filter(
      (a) => a.textContent === "Get Squeak for Mac",
    );
    expect(get).toHaveLength(2);
    expect(get[0]!.getAttribute("href")).toBe(MAC_DOWNLOAD_URL);
    expect(text()).toContain("On the Mac app, sign in with a***@f***.dev and greenroom will be waiting.");
  });

  it("on any other device there is no Mac button and no Mac sentence", async () => {
    await boot({ mac: false });
    expect(text()).not.toContain("Get Squeak for Mac");
    expect(text()).not.toContain("On the Mac app");
  });

  it("Join in your browser offers sign-up, and the way back is this invitation", async () => {
    const { visited, storage } = await boot();
    expect(root.querySelector(".providers")).toBeNull();
    click("Join in your browser");
    expect(root.querySelector(".providers")).not.toBeNull();
    click("Continue with Google");
    expect(storage.getItem("squeak-return-to")).toBe("/invite/K7P4QD");
    expect(visited[0]).toContain("provider=google");
  });

  it("Not for me also asks who you are first, because only the invited address may decline", async () => {
    await boot();
    click("Not for me");
    expect(text()).toContain("Sign in with a***@f***.dev to turn this down.");
  });

  it("an unknown invitation says so in one sentence", async () => {
    await boot({ relay: { invites: {} } });
    expect(root.querySelector('[data-invite="missing"]')?.textContent).toContain("We can't find this invitation");
  });

  const settled: [InvitePreview["state"], string][] = [
    ["withdrawn", "Sibhi withdrew this invitation."],
    ["expired", "This invitation expired."],
    ["declined", "You declined this invitation."],
  ];
  for (const [state, sentence] of settled) {
    it(`${state}: one sentence, no Join, no address, and the story still shows`, async () => {
      await boot({ invite: { state } });
      expect(root.querySelector("h1")?.textContent).toBe(sentence);
      expect(labels()).not.toContain("Join in your browser");
      expect(labels()).not.toContain("Not for me");
      expect(text()).not.toContain("a***");
      expect(text()).not.toContain("expires");
      expect(root.querySelectorAll(".part")).toHaveLength(3);
      if (state !== "declined") expect(root.querySelector(".ask")?.textContent).toBe("Ask Sibhi for a new invitation.");
    });
  }

  it("already joined: says so and offers to sign in to open the Pond", async () => {
    await boot({ invite: { state: "joined" } });
    expect(root.querySelector("h1")?.textContent).toBe("You already joined.");
    click("Sign in to open greenroom");
    expect(root.querySelector(".providers")).not.toBeNull();
  });
});

describe("the invite page, signed in", () => {
  it("Join calls the relay and lands in the Pond", async () => {
    const { fake } = await boot({ signedIn: true });
    expect(root.querySelector(".hero .button.solid")?.textContent).toBe("Join greenroom");
    click("Join greenroom");
    await settle();
    expect(
      fake.state.requests.some((r) => r.method === "POST" && r.url.endsWith("/account/invitations/K7P4QD/join")),
    ).toBe(true);
    expect(window.location.hash).toBe("#/ponds/joined-K7P4QD/room");
    expect(root.querySelector('[data-screen="pond"]')).not.toBeNull();
  });

  it("after joining on a Mac, the Pond shows a card once; dismissing it keeps it gone", async () => {
    const { seen } = await boot({ signedIn: true, mac: true });
    click("Join greenroom");
    await settle();
    const card = root.querySelector(".mac-card")!;
    expect(card.textContent).toContain("Get Squeak for Mac to run Ducks of your own");
    expect(card.querySelector("a")?.getAttribute("href")).toBe(MAC_DOWNLOAD_URL);
    click("Dismiss");
    expect(root.querySelector(".mac-card")).toBeNull();
    expect(seen.getItem(MAC_CARD_KEY)).toBe("done");
  });

  it("after joining on another device there is no Mac card", async () => {
    await boot({ signedIn: true, mac: false });
    click("Join greenroom");
    await settle();
    expect(root.querySelector('[data-screen="pond"]')).not.toBeNull();
    expect(root.querySelector(".mac-card")).toBeNull();
  });

  it("Not for me declines through the relay and the page says so", async () => {
    const { fake } = await boot({ signedIn: true });
    click("Not for me");
    await settle();
    expect(fake.state.requests.some((r) => r.url.endsWith("/account/invitations/K7P4QD/decline"))).toBe(true);
    expect(root.querySelector("h1")?.textContent).toBe("You declined this invitation.");
    expect(labels()).not.toContain("Join greenroom");
  });

  it("another address: shows the masked address and Switch account, and the invite stays pending", async () => {
    const { storage } = await boot({
      signedIn: true,
      relay: { refusal: { status: 403, body: { error: "email" } } },
    });
    click("Join greenroom");
    await settle();
    const alert = root.querySelector('[data-problem="email"]')!;
    expect(alert.textContent).toContain("This invitation is for a***@f***.dev");
    expect(root.querySelector("h1")?.textContent).toBe("Sibhi invited you to greenroom");
    expect(window.location.hash).toBe("#/invite/K7P4QD");
    act(() => alert.querySelector("button")!.click());
    await settle();
    expect(storage.getItem("squeak-account-token")).toBeNull();
    expect(root.querySelector(".hero .button.solid")?.textContent).toBe("Join in your browser");
  });

  it("an invite that was settled meanwhile is redrawn as that state", async () => {
    await boot({
      signedIn: true,
      relay: { refusal: { status: 409, body: { error: "state", state: "withdrawn" } } },
    });
    click("Join greenroom");
    await settle();
    expect(root.querySelector("h1")?.textContent).toBe("Sibhi withdrew this invitation.");
  });

  it("a cloud failure says so once and keeps Join", async () => {
    await boot({ signedIn: true, relay: { respond: "fail" } });
    click("Join greenroom");
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("didn't work");
    expect(labels()).toContain("Join greenroom");
  });

  it("already joined opens the Pond list", async () => {
    await boot({ signedIn: true, invite: { state: "joined" } });
    expect(root.querySelector('a.button.solid[href="#/ponds"]')?.textContent).toBe("Open greenroom");
  });
});

describe("isMac", () => {
  it("is a Mac, not an iPhone or an iPad that says Macintosh", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(isMac({ userAgent: mac, maxTouchPoints: 0 })).toBe(true);
    expect(isMac({ userAgent: mac, maxTouchPoints: 5 })).toBe(false);
    expect(isMac({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe(false);
    expect(isMac({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe(false);
  });
});
