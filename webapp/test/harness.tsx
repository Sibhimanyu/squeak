// Shared test plumbing: a signed-in app over the fake relay, an Owner's Mac per Pond, and waiting for real WebCrypto work
// (which settles on the thread pool, not in microtasks) without moving the page's own timers.

import { render } from "preact";
import { act } from "preact/test-utils";
import { vi } from "vitest";
import type { PondRole, PondSummary } from "../../src/shared/shapes.js";
import { App } from "../src/app.js";
import { createAuth } from "../src/auth/auth.js";
import { createMemoryVault, type KeyVault } from "../src/device/vault.js";
import { createRelay } from "../src/relay/client.js";
import { createFakeRelay, type FakeRelayState } from "../src/relay/fake.js";
import { POLL_MS } from "../src/relay/live.js";
import { createRouter } from "../src/router.js";
import { ASHA, CONFIG, memoryStore, storedToken, TOKEN } from "./helpers.js";
import { createOwnerMac, type MacMember, type OwnerMac } from "./owner-mac.js";

export const wait = (ms = 8): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Lets pending promises and WebCrypto settle, inside `act` so the page redraws. */
export const settle = (rounds = 6): Promise<void> =>
  act(async () => {
    for (let i = 0; i < rounds; i++) await wait(4);
  });

/** Waits until `check` holds, settling between looks (the page's own timers stay as they are). */
export async function until(check: () => unknown, what = "condition"): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await settle(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The poll cue: nothing else makes the page read again when no live service is configured. */
export const poll = async (): Promise<void> => {
  act(() => void vi.advanceTimersByTime(POLL_MS));
  await settle();
};

export interface Booted {
  root: HTMLElement;
  fake: ReturnType<typeof createFakeRelay>;
  vault: KeyVault;
  unmount(): void;
  text(selector: string): string | undefined;
}

export interface PondSetup {
  mac: OwnerMac;
  asha: MacMember | null;
  summary: PondSummary;
}

/** An Owner's Mac with a Pond that Asha (the signed-in account) belongs to in the given role. */
export function makePond(
  fake: FakeRelayState,
  o: { pondId: string; name: string; role: PondRole; ownerName?: string; at?: number },
): PondSetup {
  const mine = o.role === "owner";
  const mac = createOwnerMac(fake, {
    pondId: o.pondId,
    ownerName: mine ? "Asha" : (o.ownerName ?? "Sibhi"),
    ownerAccountId: mine ? ASHA.userId : "u-sibhi",
    tokens: [TOKEN],
    ...(o.at ? { startedAt: o.at - 20_000 } : {}),
  });
  const asha = mine ? (mac.members[0] ?? null) : mac.addMember("Asha", o.role, ASHA.userId);
  const summary: PondSummary = {
    pondId: o.pondId,
    name: o.name,
    ownerName: mine ? "Asha" : (o.ownerName ?? "Sibhi"),
    ownerKey: mac.ownerKey,
    mine,
    role: o.role,
    shared: true,
    lastActivityAt: o.at ?? Date.now(),
    seqHead: 0,
    counts: { members: 2, ducks: 0 },
  };
  return { mac, asha, summary };
}

export function bootApp(
  fake: ReturnType<typeof createFakeRelay>,
  o: {
    hash?: string;
    vault?: KeyVault;
    seen?: Record<string, string>;
    /** Who the live service says is online; with this set the app has a live service (no stream ever says hello). */
    presence?: () => { userId: string; online: boolean }[];
  } = {},
): Booted {
  window.location.hash = o.hash ?? "#/ponds";
  const relay = createRelay(CONFIG.relayBase, fake.fetch);
  const auth = createAuth({ config: CONFIG, relay, storage: memoryStore(storedToken()), navigate: () => {} });
  const router = createRouter(window);
  const vault = o.vault ?? createMemoryVault();
  const root = document.createElement("div");
  document.body.append(root);
  const liveFetch = (async (url: string) => {
    if (url.includes("/presence"))
      return new Response(JSON.stringify({ members: o.presence?.() ?? [] }), { status: 200 });
    // The stream never says hello: the page keeps polling, which is what these tests drive.
    return new Response(new ReadableStream<Uint8Array>({ start: () => undefined }), { status: 200 });
  }) as unknown as typeof fetch;
  act(() =>
    render(
      <App
        auth={auth}
        relay={relay}
        router={router}
        liveBase={o.presence ? "https://live.example.test" : null}
        {...(o.presence ? { liveFetch } : {})}
        vault={vault}
        seen={memoryStore(o.seen)}
      />,
      root,
    ),
  );
  return {
    root,
    fake,
    vault,
    unmount() {
      render(null, root);
      root.remove();
    },
    text: (sel) => root.querySelector(sel)?.textContent?.trim(),
  };
}

export const withAsha = (
  overviews: FakeRelayState["overviews"],
  ponds: PondSummary[],
): FakeRelayState["overviews"] => ({
  ...overviews,
  [TOKEN]: { invitations: [], ponds },
});

export const newWorld = (): ReturnType<typeof createFakeRelay> =>
  createFakeRelay({ accounts: { [TOKEN]: ASHA }, overviews: { [TOKEN]: { ponds: [], invitations: [] } } });
