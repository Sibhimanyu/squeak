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
    mount(<SignIn state={{ status: "signed-out" }} onSignIn={() => {}} onRetry={() => {}} />);
    expect(buttons()).toEqual(["Continue with Zoho", "Continue with Google", "Continue with email"]);
    expect(root.querySelector("img.lockup")?.getAttribute("src")).toBe("brand/squeak-lockup-stacked-ink.svg");
    expect(root.querySelector("source")?.getAttribute("media")).toBe("(prefers-color-scheme: dark)");
    expect(root.querySelector(".blurb")?.textContent).toContain("calm place");
  });

  it("a failure is one sentence and Try again, with no provider buttons", () => {
    const retry = vi.fn();
    mount(<SignIn state={{ status: "failed", message: UNREACHABLE_MESSAGE }} onSignIn={() => {}} onRetry={retry} />);
    expect(root.querySelector('[role="alert"] p')?.textContent).toBe(UNREACHABLE_MESSAGE);
    expect(buttons()).toEqual(["Try again"]);
    act(() => root.querySelector("button")!.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it("reports the chosen provider", () => {
    const pick = vi.fn();
    mount(<SignIn state={{ status: "signed-out" }} onSignIn={pick} onRetry={() => {}} />);
    act(() => root.querySelectorAll("button")[1]!.click());
    expect(pick).toHaveBeenCalledWith("google");
  });
});

describe("App with a fake relay", () => {
  const boot = (stored: Record<string, string>, relayState = {}) => {
    const fake = createFakeRelay({
      accounts: { [TOKEN]: ASHA },
      invites: { K7P4QD: INVITE },
      overviews: { [TOKEN]: { ponds: [], invitations: [] } },
      ...relayState,
    });
    const relay = createRelay(CONFIG.relayBase, fake.fetch);
    const visited: string[] = [];
    const storage = memoryStore(stored);
    const auth = createAuth({ config: CONFIG, relay, storage, navigate: (u) => visited.push(u) });
    mount(<App auth={auth} relay={relay} router={createRouter(window)} />);
    return { visited, storage, fake };
  };

  it("an unknown route code still shows the plain sign-in on the Pond list", async () => {
    window.location.hash = "#/ponds";
    boot({});
    await flush();
    expect(buttons()).toHaveLength(3);
  });

  it("signed in: draws the router skeleton for each route", async () => {
    window.location.hash = "#/ponds/p1/ducks/d1";
    boot(storedToken(), {
      overviews: {
        [TOKEN]: {
          invitations: [],
          ponds: [
            {
              pondId: "p1",
              name: "p1",
              ownerName: "Asha",
              ownerKey: "AAAA",
              mine: true,
              role: "owner" as const,
              shared: false,
              lastActivityAt: 1,
              seqHead: 0,
              counts: { members: 1, ducks: 0 },
            },
          ],
        },
      },
    });
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
