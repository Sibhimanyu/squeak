// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { createAuth, UNREACHABLE_MESSAGE } from "../src/auth/auth.js";
import { createRelay } from "../src/relay/client.js";
import { createFakeRelay } from "../src/relay/fake.js";
import { createRouter } from "../src/router.js";
import { SignIn } from "../src/views/SignIn.js";
import { ASHA, CONFIG, memoryStore, storedToken, TOKEN } from "./helpers.js";

const INVITE = {
  inviter: "Sibhi",
  pond: "greenroom",
  members: ["Sibhi", "Mo"],
  state: "pending" as const,
  masked: "a***@f***.dev",
  expiresAt: Date.UTC(2026, 11, 3, 12),
};

let root: HTMLElement;
const mount = (node: preact.VNode): HTMLElement => {
  root = document.createElement("div");
  document.body.append(root);
  act(() => render(node, root));
  return root;
};
const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));
afterEach(() => {
  render(null, root);
  root.remove();
  window.location.hash = "";
});

const buttons = () => [...root.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("SignIn view", () => {
  it("shows the lockup, one line and three equal provider buttons, nothing else", () => {
    mount(<SignIn state={{ status: "signed-out" }} invite={null} onSignIn={() => {}} onRetry={() => {}} />);
    expect(buttons()).toEqual(["Continue with Zoho", "Continue with Google", "Continue with email"]);
    expect(root.querySelector("img.lockup")?.getAttribute("src")).toBe("brand/squeak-lockup-stacked-ink.svg");
    expect(root.querySelector("source")?.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    expect(root.querySelector(".blurb")?.textContent).toContain("calm place");
    expect(root.querySelector(".invite-card")).toBeNull();
  });

  it("names the inviter above the same buttons for an invite link", () => {
    mount(<SignIn state={{ status: "signed-out" }} invite={INVITE} onSignIn={() => {}} onRetry={() => {}} />);
    const card = root.querySelector(".invite-card")!;
    expect(card.querySelector("h2")?.textContent).toBe("Sibhi invited you to greenroom");
    expect(card.textContent).toContain("Sign in with a***@f***.dev and greenroom will be waiting.");
    expect(card.textContent).not.toContain("asha@fernlabs.dev");
    expect(card.textContent).toContain("The invitation expires 3 Dec.");
    expect(
      card.compareDocumentPosition(root.querySelector(".buttons")!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(buttons()).toHaveLength(3);
  });

  it("a withdrawn invitation is one sentence plus who is in it, with no address or expiry", () => {
    const withdrawn = { ...INVITE, state: "withdrawn" as const };
    mount(<SignIn state={{ status: "signed-out" }} invite={withdrawn} onSignIn={() => {}} onRetry={() => {}} />);
    const card = root.querySelector(".invite-card")!;
    expect(card.textContent).toContain("Sibhi withdrew this invitation.");
    expect(card.textContent).toContain("In greenroom: Sibhi, Mo.");
    expect(card.textContent).not.toContain("a***");
    expect(card.textContent).not.toContain("expires");
  });

  it("a failure is one sentence and Try again, with no provider buttons", () => {
    const retry = vi.fn();
    mount(
      <SignIn
        state={{ status: "failed", message: UNREACHABLE_MESSAGE }}
        invite={null}
        onSignIn={() => {}}
        onRetry={retry}
      />,
    );
    expect(root.querySelector('[role="alert"] p')?.textContent).toBe(UNREACHABLE_MESSAGE);
    expect(buttons()).toEqual(["Try again"]);
    act(() => root.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reports the chosen provider", () => {
    const pick = vi.fn();
    mount(<SignIn state={{ status: "signed-out" }} invite={null} onSignIn={pick} onRetry={() => {}} />);
    act(() => root.querySelectorAll("button")[1]!.click());
    expect(pick).toHaveBeenCalledWith("google");
  });
});

describe("App with a fake relay", () => {
  const boot = (stored: Record<string, string>, relayState = {}) => {
    const fake = createFakeRelay({
      accounts: { [TOKEN]: ASHA },
      invites: { K7P4QD: INVITE },
      overviews: { [TOKEN]: { ponds: [], invitations: [], needsYou: [] } },
      ...relayState,
    });
    const relay = createRelay(CONFIG.relayBase, fake.fetch);
    const visited: string[] = [];
    const storage = memoryStore(stored);
    const auth = createAuth({ config: CONFIG, relay, storage, navigate: (u) => visited.push(u) });
    mount(<App auth={auth} relay={relay} router={createRouter(window)} />);
    return { visited, storage, fake };
  };

  it("signed out on an invite link: previews it, and Continue saves the way back", async () => {
    window.location.hash = "#/join/K7P4QD";
    const { visited, storage } = boot({});
    await flush();
    expect(root.querySelector(".invite-card h2")?.textContent).toBe("Sibhi invited you to greenroom");
    act(() => root.querySelectorAll("button")[0]!.click());
    expect(storage.getItem("squeak-return-to")).toBe("/join/K7P4QD");
    expect(visited[0]).toContain("/account/handoff?");
    expect(visited[0]).toContain("provider=zoho");
  });

  it("an unknown invite code still shows the plain sign-in", async () => {
    window.location.hash = "#/join/NOPE";
    boot({});
    await flush();
    expect(root.querySelector(".invite-card")).toBeNull();
    expect(buttons()).toHaveLength(3);
  });

  it("signed in: draws the router skeleton for each route", async () => {
    window.location.hash = "#/ponds/p1/ducks/d1";
    boot(storedToken());
    await flush();
    expect(root.querySelector(".shell")?.getAttribute("data-route")).toBe("duck");
    expect(root.querySelector('[data-screen="duck"]')).not.toBeNull();
    act(() => {
      window.location.hash = "#/ponds/p1/ducks";
    });
    await flush();
    expect(root.querySelector('[data-screen="pond"] [aria-selected="true"]')?.textContent).toBe("Ducks");
  });

  it("an unreachable relay shows one sentence and Try again, and Try again recovers", async () => {
    const { fake } = boot(storedToken(), { mode: "down" });
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(UNREACHABLE_MESSAGE);
    fake.state.mode = "up";
    act(() => root.querySelector("button")!.click());
    await flush();
    expect(root.querySelector(".shell")).not.toBeNull();
  });
});
