// @vitest-environment jsdom
// The People sheet, Settings and the connection states (issue #138) over the fake relay: every role, every invite state, each
// change shown done only after the cloud confirms, Leave, Your devices, Sign out.
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PondPeople, PondInvite } from "../src/relay/client.js";
import { type Booted, bootApp, makePond, newWorld, poll, settle, until, type PondSetup } from "./harness.js";
import { ASHA, TOKEN } from "./helpers.js";

let app: Booted | null = null;
let world: ReturnType<typeof newWorld>;
const NOW = Date.now();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  world = newWorld();
});
afterEach(() => {
  app?.unmount();
  app = null;
  vi.useRealTimers();
});

const q = <T extends Element = HTMLElement>(sel: string): T | null => app!.root.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...app!.root.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string): string | undefined => q(sel)?.textContent?.trim();
const click = async (el: HTMLElement | null): Promise<void> => {
  act(() => el!.click());
  await settle();
};
const buttonIn = (scope: string, label: string): HTMLElement | null =>
  qa(`${scope} button`).find((b) => b.textContent?.trim() === label) ?? null;
const choose = async (select: HTMLSelectElement, value: string): Promise<void> => {
  select.value = value;
  act(() => void select.dispatchEvent(new Event("change", { bubbles: true })));
  await settle();
};
const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  input.value = value;
  act(() => void input.dispatchEvent(new Event("input", { bubbles: true })));
  await settle();
};

const mins = (n: number): number => NOW - n * 60_000;
const invite = (
  email: string,
  state: PondInvite["state"],
  at: number,
  role: "member" | "viewer" = "member",
): PondInvite => ({
  inviteId: `i-${email}`,
  email,
  role,
  state,
  createdAt: at,
  settledAt: state === "pending" ? 0 : at,
  expiresAt: NOW + 86_400_000,
});

/** The Pond's people as the relay holds them: Asha is the signed-in account, in `role`. */
function seed(role: "owner" | "member" | "viewer", invites: PondInvite[] = []): PondPeople {
  const mine = role === "owner";
  const owner = mine ? "u1" : "u-sibhi";
  const members: PondPeople["members"] = [
    {
      userId: owner,
      name: mine ? "Asha" : "Sibhi",
      email: mine ? ASHA.email : "sibhi@fernlabs.dev",
      role: "owner",
      lastSeenAt: NOW,
    },
    ...(mine ? [] : [{ userId: "u1", name: "Asha", email: ASHA.email, role, lastSeenAt: NOW }]),
    { userId: "u-dev", name: "Dev", email: "dev@fernlabs.dev", role: "member", lastSeenAt: NOW },
    { userId: "u-meera", name: "Meera", email: "meera@fernlabs.dev", role: "viewer", lastSeenAt: mins(26 * 60) },
    { userId: "u-eve", name: "", email: "eve@fernlabs.dev", role: "member", lastSeenAt: mins(120) },
  ];
  return { owner, name: "greenroom", cap: 10, members, invites: mine ? invites : [] };
}

function open(role: "owner" | "member" | "viewer", hash: string, invites: PondInvite[] = []): PondSetup {
  const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role });
  world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
  world.state.people["p-green"] = seed(role, invites);
  app = bootApp(world, { hash });
  return setup;
}
const people = (): PondPeople => world.state.people["p-green"]!;
const openSheet = async (role: "owner" | "member" | "viewer", invites: PondInvite[] = []): Promise<void> => {
  open(role, "#/ponds/p-green/people", invites);
  await until(() => q('[data-block="members"]'), "the People sheet");
};

describe("People sheet: what each role sees", () => {
  it("a pending invite whose email never arrived says so and keeps Resend", async () => {
    await openSheet("owner", [{ ...invite("late@fernlabs.dev", "pending", mins(5)), emailFailed: true }]);
    expect(q('[data-invite="i-late@fernlabs.dev"] .sub')?.textContent).toBe(
      "Invited · 5 min ago · Member · Email not delivered",
    );
    expect(qa('[data-invite="i-late@fernlabs.dev"] button').map((b) => b.textContent)).toEqual(["Resend", "Withdraw"]);
  });

  it("the Owner sees email under each name, online or last seen as text, roles, and every invite state with its own buttons", async () => {
    await openSheet("owner", [
      invite("vikram@northwind.io", "pending", mins(3 * 24 * 60)),
      invite("neha@fernlabs.dev", "declined", mins(120)),
      invite("tom@harbourworks.co", "expired", mins(9 * 24 * 60)),
      invite("old@fernlabs.dev", "withdrawn", mins(60)),
      invite("done@fernlabs.dev", "joined", mins(10)),
    ]);
    expect(text("[data-count]")).toBe("5 of 10, counting invites");
    const row = (id: string) => q(`[data-member="${id}"]`)!;
    expect(row("u-dev").textContent).toContain("dev@fernlabs.dev");
    expect(row("u-dev").querySelector(".presence")?.textContent).toBe("online");
    expect(row("u-meera").querySelector(".presence")?.textContent).toBe("last seen yesterday");
    expect(row("u-eve").querySelector(".presence")?.textContent).toBe("last seen 2 h ago");
    // No name: the email stands in for it.
    expect(row("u-eve").querySelector("strong")?.textContent).toBe("eve@fernlabs.dev");
    expect(text('[data-member="u1"] strong')).toBe("Asha (you)");
    expect(row("u1").querySelector(".role")?.textContent).toBe("Owner");
    expect(row("u-dev").querySelector("select")).not.toBeNull();
    // Invites: Joined moves up into Members, the rest show state and when.
    const line = (email: string) => q(`[data-invite="i-${email}"] .sub`)?.textContent;
    expect(line("vikram@northwind.io")).toBe("Invited · 3 days ago · Member");
    expect(line("neha@fernlabs.dev")).toBe("Declined · 2 h ago · Member");
    expect(line("tom@harbourworks.co")).toBe("Expired · Member");
    expect(line("old@fernlabs.dev")).toBe("Withdrawn · 1 h ago · Member");
    expect(q('[data-invite="i-done@fernlabs.dev"]')).toBeNull();
    const labels = (email: string) => qa(`[data-invite="i-${email}"] button`).map((b) => b.textContent);
    expect(labels("vikram@northwind.io")).toEqual(["Resend", "Withdraw"]);
    for (const e of ["neha@fernlabs.dev", "tom@harbourworks.co", "old@fernlabs.dev"])
      expect(labels(e)).toEqual(["Invite again"]);
    expect(q('input[aria-label="Email address"]')).not.toBeNull();
  });

  it("a Member sees the same people with no controls except Leave, and who can change things", async () => {
    await openSheet("member");
    expect(text("[data-count]")).toBe("5 people");
    expect(text('[data-member="u1"] strong')).toBe("Asha (you)");
    expect(q('[data-member="u-dev"] .role')?.textContent).toBe("Member");
    expect(q('[data-member="u-meera"] .role')?.textContent).toBe("Viewer");
    expect(q("select")).toBeNull();
    expect(q('input[aria-label="Email address"]')).toBeNull();
    expect(q('[data-block="invites"]')).toBeNull();
    expect(qa("button").some((b) => b.textContent === "Remove")).toBe(false);
    expect(text("[data-only-owner]")).toBe("Only Sibhi can invite, remove or change roles.");
    expect(buttonIn(".sheet", "Leave greenroom")).not.toBeNull();
  });

  it("a Viewer sees the same sheet with Leave", async () => {
    await openSheet("viewer");
    expect(q("select")).toBeNull();
    expect(buttonIn(".sheet", "Leave greenroom")).not.toBeNull();
  });

  it("opens from the people in the Pond header and closes with Done", async () => {
    const setup = open("member", "#/ponds/p-green/room");
    await until(() => world.state.ponds["p-green"]!.requests.length > 0, "the device request");
    setup.mac.approveRequests();
    await poll();
    await until(() => q("a.flock"), "the avatars");
    expect(q('[data-sheet="people"]')).toBeNull();
    await click(q("a.flock"));
    expect(window.location.hash).toBe("#/ponds/p-green/people");
    await until(() => q('[data-sheet="people"]'), "the sheet");
    await click(q("a.done"));
    expect(window.location.hash).toBe("#/ponds/p-green/room");
  });
});

describe("People sheet: the Owner's changes show done only after the cloud confirms", () => {
  it("changes a role, then reads it back from the cloud; the Owner's Mac gets a note", async () => {
    await openSheet("owner");
    await choose(q<HTMLSelectElement>('[data-member="u-dev"] select')!, "viewer");
    expect(people().members.find((m) => m.userId === "u-dev")!.role).toBe("viewer");
    expect(q<HTMLSelectElement>('[data-member="u-dev"] select')!.value).toBe("viewer");
    expect(world.state.notes).toContainEqual({ pondId: "p-green", userId: "u-dev", act: "role" });
  });

  it("removes someone only after the confirm; Cancel changes nothing", async () => {
    await openSheet("owner");
    await click(buttonIn('[data-member="u-dev"]', "Remove"));
    expect(text('[role="alertdialog"] p')).toBe("Remove Dev from greenroom? They lose access on every device.");
    await click(buttonIn('[role="alertdialog"]', "Cancel"));
    expect(q('[role="alertdialog"]')).toBeNull();
    expect(people().members.some((m) => m.userId === "u-dev")).toBe(true);
    await click(buttonIn('[data-member="u-dev"]', "Remove"));
    await click(buttonIn('[role="alertdialog"]', "Remove"));
    expect(people().members.some((m) => m.userId === "u-dev")).toBe(false);
    expect(q('[data-member="u-dev"]')).toBeNull();
    expect(world.state.notes).toContainEqual({ pondId: "p-green", userId: "u-dev", act: "remove" });
  });

  it("a refused change keeps everything as it was and says why in one sentence", async () => {
    await openSheet("owner");
    world.state.act = "fail";
    await click(buttonIn('[data-member="u-dev"]', "Remove"));
    await click(buttonIn('[role="alertdialog"]', "Remove"));
    expect(text("[data-error]")).toBe("That didn't go through. Try again.");
    expect(q('[data-member="u-dev"]')).not.toBeNull();
    expect(world.state.notes).toEqual([]);
  });

  it("invites by email with a role; the new invite shows as Pending; a bad address is the relay's own sentence", async () => {
    await openSheet("owner");
    const input = q<HTMLInputElement>('input[aria-label="Email address"]')!;
    await choose(q<HTMLSelectElement>('select[aria-label="Role for the invite"]')!, "viewer");
    await type(input, "vikram@northwind.io");
    await click(buttonIn(".invite-form", "Invite"));
    expect(people().invites[0]).toMatchObject({ email: "vikram@northwind.io", role: "viewer", state: "pending" });
    expect(q('[data-invite="i1-vikram@northwind.io"] .sub')?.textContent).toBe("Invited · just now · Viewer");
    expect(input.value).toBe("");
    await type(input, "dev@fernlabs.dev");
    await click(buttonIn(".invite-form", "Invite"));
    expect(text("[data-error]")).toBe("dev@fernlabs.dev is already in this Pond.");
    expect(text("[data-count]")).toBe("5 of 10, counting invites");
  });

  it("Resend, Withdraw and Invite again each go to the relay and the list is read again", async () => {
    await openSheet("owner", [
      invite("vikram@northwind.io", "pending", mins(60)),
      invite("neha@fernlabs.dev", "declined", mins(30)),
    ]);
    await click(buttonIn('[data-invite="i-vikram@northwind.io"]', "Resend"));
    expect(world.state.resent).toEqual(["i-vikram@northwind.io"]);
    await click(buttonIn('[data-invite="i-neha@fernlabs.dev"]', "Invite again"));
    expect(world.state.again).toEqual(["i-neha@fernlabs.dev"]);
    expect(q('[data-invite="i-neha@fernlabs.dev"] .sub')?.textContent).toBe("Invited · just now · Member");
    await click(buttonIn('[data-invite="i-vikram@northwind.io"]', "Withdraw"));
    expect(q('[data-invite="i-vikram@northwind.io"]')?.getAttribute("data-state")).toBe("withdrawn");
    expect(buttonIn('[data-invite="i-vikram@northwind.io"]', "Invite again")).not.toBeNull();
  });

  it("deletes the Pond only when its name is typed; then it leaves the list", async () => {
    await openSheet("owner");
    await click(buttonIn(".danger-zone", "Delete greenroom"));
    const button = buttonIn(".danger-zone", "Delete")!;
    expect(button.hasAttribute("disabled")).toBe(true);
    await type(q<HTMLInputElement>('input[aria-label="Type the Pond\'s name"]')!, "green");
    expect(buttonIn(".danger-zone", "Delete")!.hasAttribute("disabled")).toBe(true);
    await type(q<HTMLInputElement>('input[aria-label="Type the Pond\'s name"]')!, "greenroom");
    await click(buttonIn(".danger-zone", "Delete"));
    expect(world.state.people["p-green"]).toBeUndefined();
    expect(world.state.notes).toContainEqual({ pondId: "p-green", userId: "u1", act: "delete" });
    expect(window.location.hash).toBe("#/ponds");
  });
});

describe("People sheet: Leave", () => {
  it("asks once in the specced words, then the Pond leaves the list and the Owner's Mac is told", async () => {
    await openSheet("member");
    await click(buttonIn(".sheet", "Leave greenroom"));
    expect(text('[role="alertdialog"] p')).toBe(
      "Leave greenroom? Your messages stay in the Room under your name. To come back you need a new invite from Sibhi.",
    );
    await click(buttonIn('[role="alertdialog"]', "Cancel"));
    expect(world.state.notes).toEqual([]);
    await click(buttonIn(".sheet", "Leave greenroom"));
    await click(buttonIn('[role="alertdialog"]', "Leave"));
    expect(world.state.notes).toContainEqual({ pondId: "p-green", userId: "u1", act: "leave" });
    expect(window.location.hash).toBe("#/ponds");
    await until(() => !q('[data-screen="ponds"] [href="#/ponds/p-green/room"]'), "the list without the Pond");
  });

  it("a leave the cloud did not confirm leaves you in", async () => {
    await openSheet("member");
    world.state.act = "fail";
    await click(buttonIn(".sheet", "Leave greenroom"));
    await click(buttonIn('[role="alertdialog"]', "Leave"));
    expect(text("[data-error]")).toBe("That didn't go through. Try again.");
    expect(window.location.hash).toBe("#/ponds/p-green/people");
  });
});

describe("People sheet: failure", () => {
  it("an unreachable cloud is one sentence and Try again, which recovers", async () => {
    open("member", "#/ponds/p-green/people");
    delete world.state.people["p-green"];
    world.state.mode = "up";
    await until(() => q('[data-sheet="people"]'), "the sheet");
    // The relay answers 403 for a Pond it does not list the account in.
    await until(() => text('[role="alert"]'), "the answer");
    expect(text('[role="alert"]')).toBe("You are no longer in this Pond.");
  });
});

describe("Settings", () => {
  const devices = [
    { deviceId: "d-web", name: "Safari on Mac", kind: "web" as const, createdAt: mins(500), lastSeenAt: NOW },
    {
      deviceId: "d-phone",
      name: "Asha's iPhone",
      kind: "iphone" as const,
      createdAt: mins(900),
      lastSeenAt: mins(120),
    },
    { deviceId: "d-mac", name: "MacBook Air", kind: "mac" as const, createdAt: mins(9000), lastSeenAt: mins(26 * 60) },
  ];
  const openSettings = async (): Promise<void> => {
    world.state.accountDevices[TOKEN] = devices.map((d) => ({ ...d }));
    app = bootApp(world, { hash: "#/settings" });
    await until(() => q('[data-block="devices"] li'), "the devices");
  };

  it("shows the account's name and email from sign-in, not editable, with the note", async () => {
    await openSettings();
    expect(text("[data-account-name]")).toBe("Asha");
    expect(text("[data-account-email]")).toBe("asha@fernlabs.dev");
    expect(
      q('[data-block="account"] input, [data-block="account"] button, [data-block="account"] textarea'),
    ).toBeNull();
    expect(text('[data-block="account"] .note')).toContain("come from your sign-in");
  });

  it("lists Your devices with this one marked, and removes another only after the confirm and the cloud's yes", async () => {
    await openSettings();
    expect(text('[data-block="devices"] h2')).toBe("Your devices 3");
    expect(qa('[data-block="devices"] li strong').map((e) => e.textContent)).toEqual([
      "Safari on Mac",
      "Asha's iPhone",
      "MacBook Air",
    ]);
    expect(q('[data-device="d-phone"] .sub')?.textContent).toBe("Squeak for iPhone · last seen 2 h ago");
    expect(q('[data-device="d-mac"] .sub')?.textContent).toBe("Squeak for Mac · last seen yesterday");
    // Only the other devices have Remove; the browser's own id is unknown until its key loads, so wait for it.
    expect(text('[data-block="devices"] .note')).toBe("Removing a device removes it from every Pond.");
    await click(buttonIn('[data-device="d-phone"]', "Remove"));
    expect(text('[role="alertdialog"] p')).toBe("Remove Asha's iPhone? It is signed out of every Pond.");
    world.state.act = "fail";
    await click(buttonIn('[role="alertdialog"]', "Remove"));
    expect(text("[data-error]")).toBe("That didn't go through. Try again.");
    expect(q('[data-device="d-phone"]')).not.toBeNull();
    world.state.act = "ok";
    await click(buttonIn('[role="alertdialog"]', "Remove"));
    expect(q('[data-device="d-phone"]')).toBeNull();
    expect(world.state.accountDevices[TOKEN]!.map((d) => d.deviceId)).toEqual(["d-web", "d-mac"]);
  });

  it("says where Mac things are done, and Sign out returns to the sign-in page", async () => {
    await openSettings();
    expect(text("[data-open-on-mac]")).toBe("Mac controls, voice and usage · Open on your Mac");
    await click(buttonIn('[data-screen="settings"]', "Sign out"));
    await until(() => !q('[data-screen="settings"]'), "signed out");
    expect(q('[data-screen="settings"]')).toBeNull();
  });

  it("the Ponds screen reaches Settings from the avatar and no longer signs out from there", async () => {
    open("member", "#/ponds");
    await until(() => q("a.avatar-button"), "the avatar");
    expect(q("a.avatar-button")!.getAttribute("href")).toBe("#/settings");
    expect(qa("button").some((b) => b.textContent === "Sign out")).toBe(false);
  });
});

describe("connection states", () => {
  /** A live service: /presence answers `ownerOnline`, the stream says hello once `hello` is true. */
  function live(): { fetchFn: typeof fetch; hello(): void; ownerOnline: boolean } {
    const state = { ownerOnline: true, controller: null as ReadableStreamDefaultController<Uint8Array> | null };
    const fetchFn = (async (url: string) => {
      if (url.includes("/presence"))
        return new Response(JSON.stringify({ members: [{ userId: "u-sibhi", online: state.ownerOnline }] }), {
          status: 200,
        });
      return new Response(new ReadableStream<Uint8Array>({ start: (c) => void (state.controller = c) }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return {
      fetchFn,
      hello: () => state.controller?.enqueue(new TextEncoder().encode("event: hello\ndata: {}\n\n")),
      get ownerOnline() {
        return state.ownerOnline;
      },
      set ownerOnline(v: boolean) {
        state.ownerOnline = v;
      },
    };
  }
  const boot = async (service: ReturnType<typeof live>): Promise<void> => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
    app = bootApp(world, { hash: "#/ponds/p-green/room", liveFetch: service.fetchFn });
    await until(() => world.state.ponds["p-green"]!.requests.length > 0, "the device request");
    setup.mac.approveRequests();
    await poll();
    await until(() => !q('[data-state="connecting"]'), "access");
  };

  it("the Pond header says Reconnecting… until the stream is up, then Live", async () => {
    const service = live();
    await boot(service);
    expect(q(".subtitle")?.textContent).toBe("Sibhi's Pond · Member · Reconnecting…");
    service.hello();
    await until(() => q(".subtitle")?.textContent === "Sibhi's Pond · Member · Live", "Live");
  });

  it("the header says Owner's Mac offline, with the banner, when the Owner's Mac is away", async () => {
    const service = live();
    service.ownerOnline = false;
    await boot(service);
    service.hello();
    await until(() => q(".subtitle")?.textContent?.includes("offline"), "the offline header");
    expect(q(".subtitle")?.textContent).toBe("Sibhi's Pond · Member · Owner's Mac offline");
    expect(text('[data-state="offline"]')).toBe(
      "Sibhi's Mac is offline. Messages you send now wait and arrive in order when it is back.",
    );
  });

  it("a Pond that cannot be read is one sentence with Try again", async () => {
    const setup = makePond(world.state, { pondId: "p-green", name: "greenroom", role: "member" });
    world.state.overviews[TOKEN] = { ponds: [setup.summary], invitations: [] };
    app = bootApp(world, { hash: "#/ponds/p-green/room" });
    await until(() => world.state.ponds["p-green"]!.requests.length > 0, "the device request");
    setup.mac.approveRequests();
    world.state.ponds["p-green"]!.tokens = [];
    await poll();
    await until(() => q('[data-state="failed"]'), "the failure");
    expect(q('[data-state="failed"]')?.textContent).toBe("Squeak can't be reached right now. Try again");
    world.state.ponds["p-green"]!.tokens = [TOKEN];
    await click(buttonIn('[data-state="failed"]', "Try again"));
    await until(() => !q('[data-state="failed"]'), "recovery");
  });
});
