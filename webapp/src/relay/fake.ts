// A fake relay for tests, speaking the relay's HTTP as a `fetch` so `createRelay` is exercised end to end. It records every
// request (with its body) so a test can assert the account header is sent, no cookie is asked for and no plaintext ever travels.
// Like the real relay it stores only sealed documents: a Pond's change feed, the device requests and the writes made with a
// Pond token. The "Owner's Mac" that answers a device request lives in the test (`test/owner-mac.ts`), not here.

import type { AccountInfo, InvitePreview, PondsOverview } from "../../../src/shared/shapes.js";
import { ACCOUNT_HEADER, type FeedChange, type FetchLike } from "./client.js";

export interface FakePond {
  /** Account tokens that are members (what `people.isMember` says). */
  tokens: string[];
  feed: FeedChange[];
  /** The Pond token a device holds once the Owner's Mac granted it (writes need it). */
  writeToken: string;
  /** Device requests, as `POST /account/pond-devices` recorded them. */
  requests: { account: string; publicKey: string; boxKey: string; client: string }[];
  /** Writes made with a Pond token, as the relay stored them. */
  writes: { path: string; token: string; doc: { box: string; sig?: string; device?: string; at?: number } }[];
  /** Answer 429 to the next device request (the relay's rate limit). */
  rateLimit?: boolean;
}

export interface FakeRelayState {
  /** Valid account tokens and who they belong to. */
  accounts: Record<string, AccountInfo>;
  invites: Record<string, InvitePreview>;
  /** "down": the network fails; "broken": the relay answers 500. */
  mode?: "up" | "down" | "broken";
  /** What each account sees on the Pond list, by token. Metadata only; `seqHead` follows the Pond's feed when it has one. */
  overviews: Record<string, PondsOverview>;
  ponds: Record<string, FakePond>;
  /** Devices registered with `POST /account/devices`, by account token. */
  devices: Record<string, { publicKey: string; name: string; kind: string }[]>;
  /** Answers to Join and Decline: set "fail" to make the cloud refuse. */
  respond?: "ok" | "fail";
  requests: {
    url: string;
    method: string;
    body: string | null;
    account: string | null;
    credentials: string | undefined;
  }[];
}

export const newFakePond = (tokens: string[]): FakePond => ({
  tokens,
  feed: [],
  writeToken: "pm.fake-pond-token",
  requests: [],
  writes: [],
});

export const createFakeRelay = (state: Partial<FakeRelayState> = {}): { fetch: FetchLike; state: FakeRelayState } => {
  const full: FakeRelayState = {
    accounts: {},
    invites: {},
    mode: "up",
    overviews: {},
    ponds: {},
    devices: {},
    requests: [],
    ...state,
  };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    full.requests.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      account: headers.get(ACCOUNT_HEADER),
      credentials: init?.credentials,
    });
    if (full.mode === "down") throw new TypeError("network down");
    if (full.mode === "broken") return json(500, { error: "boom" });
    const u = new URL(url);
    const token = headers.get(ACCOUNT_HEADER) ?? "";
    if (u.pathname.endsWith("/me")) {
      const account = full.accounts[token];
      return account ? json(200, account) : json(401, { error: "signin" });
    }
    if (u.pathname.endsWith("/account/overview")) {
      const overview = full.overviews[token];
      if (!full.accounts[token] || !overview) return json(401, { error: "signin" });
      // Metadata only: the head and the newest change's time come from the feed's own rows, never from what is inside them.
      const ponds = overview.ponds.map((p) => {
        const feed = full.ponds[p.pondId]?.feed;
        return feed && feed.length > 0
          ? { ...p, seqHead: feed[feed.length - 1]!.seq, lastActivityAt: feed[feed.length - 1]!.at ?? p.lastActivityAt }
          : p;
      });
      return json(200, { ...overview, ponds });
    }
    if (u.pathname.endsWith("/account/devices") && init?.method === "POST") {
      if (!full.accounts[token]) return json(401, { error: "signin" });
      const body = JSON.parse(String(init.body)) as { publicKey: string; name: string; kind: string };
      const mine = (full.devices[token] ??= []);
      if (!mine.some((d) => d.publicKey === body.publicKey)) mine.push(body);
      return json(200, { deviceId: "registered" });
    }
    if (u.pathname.endsWith("/account/pond-devices") && init?.method === "POST") {
      if (!full.accounts[token]) return json(401, { error: "signin" });
      const body = JSON.parse(String(init.body)) as {
        pondId: string;
        publicKey: string;
        boxKey: string;
        client: string;
      };
      const pond = full.ponds[body.pondId];
      if (!pond || !pond.tokens.includes(token)) return json(403, { error: "pond" });
      if (pond.rateLimit) return json(429, { error: "rate" });
      pond.requests.push({ account: token, publicKey: body.publicKey, boxKey: body.boxKey, client: body.client });
      return json(200, { reqId: "req", token: "pm.join-scope", expiresAt: Date.now() + 86_400_000 });
    }
    if (u.pathname.endsWith("/changes")) {
      if (!full.accounts[token]) return json(401, { error: "signin" });
      const pond = full.ponds[u.searchParams.get("pond") ?? ""];
      if (!pond || !pond.tokens.includes(token)) return json(403, {});
      const since = Number(u.searchParams.get("since"));
      const limit = Math.min(100, Number(u.searchParams.get("limit")) || 100);
      const rows = pond.feed.filter((c) => c.seq > since);
      const page = rows.slice(0, limit);
      return json(200, {
        changes: page,
        next: page.length ? page[page.length - 1]!.seq : since,
        more: rows.length > page.length,
      });
    }
    if (u.pathname.endsWith("/doc") && init?.method === "PUT") {
      const path = u.searchParams.get("path") ?? "";
      const m = /^channels\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
      const pond = m ? full.ponds[m[1]!] : undefined;
      const pondToken = headers.get("x-squeak-pond-token") ?? "";
      if (!m || !pond || pondToken !== pond.writeToken) return json(401, {});
      const doc = (JSON.parse(String(init.body)) as { doc: FakePond["writes"][number]["doc"] }).doc;
      pond.writes.push({ path, token: pondToken, doc });
      pond.feed.push({
        seq: (pond.feed[pond.feed.length - 1]?.seq ?? 0) + 1,
        kind: m[2]!,
        id: m[3]!,
        doc,
        at: Date.now(),
      });
      return new Response(null, { status: 204 });
    }
    const answer = /\/account\/invitations\/([^/]+)\/(join|decline)$/.exec(u.pathname);
    if (answer && init?.method === "POST") {
      const overview = full.overviews[token];
      if (!full.accounts[token] || !overview) return json(401, { error: "signin" });
      const invitation = overview.invitations.find((i) => i.inviteId === answer[1]);
      if (!invitation) return json(404, { error: "invite" });
      if (full.respond === "fail") return json(503, { error: "cloud" });
      overview.invitations = overview.invitations.filter((i) => i !== invitation);
      if (answer[2] === "decline") return new Response(null, { status: 204 });
      const pondId = `joined-${invitation.inviteId}`;
      overview.ponds.unshift({
        pondId,
        name: invitation.pondName,
        ownerName: invitation.inviterName,
        ownerKey: "joined-owner-key",
        mine: false,
        role: "member",
        shared: true,
        lastActivityAt: Date.now(),
        seqHead: 0,
        counts: { members: 2, ducks: 0 },
      });
      return json(200, { pondId });
    }
    if (u.pathname.endsWith("/invites/preview")) {
      const invite = full.invites[u.searchParams.get("code") ?? ""];
      return invite ? json(200, invite) : json(404, { error: "code" });
    }
    return json(404, { error: "route" });
  };
  return { fetch: fetchFn, state: full };
};
