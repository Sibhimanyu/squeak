// A fake relay for tests, speaking the relay's HTTP as a `fetch` so `createRelay` is exercised end to end. It records every
// request so a test can assert the account header is sent and no cookie is asked for.

import type { AccountInfo, InvitePreview } from "../../../src/shared/shapes.js";
import { ACCOUNT_HEADER, type FetchLike } from "./client.js";

export interface FakeRelayState {
  /** Valid account tokens and who they belong to. */
  accounts: Record<string, AccountInfo>;
  invites: Record<string, InvitePreview>;
  /** "down": the network fails; "broken": the relay answers 500. */
  mode?: "up" | "down" | "broken";
  requests: { url: string; account: string | null; credentials: string | undefined }[];
}

export const createFakeRelay = (state: Partial<FakeRelayState> = {}): { fetch: FetchLike; state: FakeRelayState } => {
  const full: FakeRelayState = { accounts: {}, invites: {}, mode: "up", requests: [], ...state };
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFn: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers);
    full.requests.push({ url, account: headers.get(ACCOUNT_HEADER), credentials: init?.credentials });
    if (full.mode === "down") throw new TypeError("network down");
    if (full.mode === "broken") return json(500, { error: "boom" });
    const u = new URL(url);
    if (u.pathname.endsWith("/me")) {
      const account = full.accounts[headers.get(ACCOUNT_HEADER) ?? ""];
      return account ? json(200, account) : json(401, { error: "signin" });
    }
    if (u.pathname.endsWith("/invites/preview")) {
      const invite = full.invites[u.searchParams.get("code") ?? ""];
      return invite ? json(200, invite) : json(404, { error: "code" });
    }
    return json(404, { error: "route" });
  };
  return { fetch: fetchFn, state: full };
};
