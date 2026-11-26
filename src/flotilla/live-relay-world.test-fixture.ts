// The People journey's world on a REAL development relay (scripts/smoke-people.ts), where the double's helpers do not exist: no
// clock to move, no mail sink, no hub to open. Three test accounts are signed in by the account tokens the daily workflow
// holds as secrets; every Mac and browser is built the way a daemon builds one (relay-mac.test-fixture.ts) and every request
// it makes is counted. No test runner is imported.
import { randomId } from "./crypto.js";
import type { JourneyWorld, Seen } from "./people-journey.test-fixture.js";
import { buildMac, type TestUser } from "./relay-mac.test-fixture.js";
import { relayBaseUrl } from "../cloud/location.js";

export interface LiveRelayInput {
  relayUrl: string;
  tokens: { owner: string; invitee: string; member: string };
}

/** The signed-in account behind a token (`GET /me`), as the journey's user. */
async function whoIs(relayUrl: string, token: string): Promise<TestUser> {
  const res = await fetch(`${relayUrl}/me`, { headers: { "x-squeak-account": token } });
  if (res.status !== 200) throw new Error(`The relay did not accept an account token (${res.status}) at /me.`);
  const me = (await res.json()) as { userId?: string; email?: string; name?: string };
  if (!me.userId || !me.email) throw new Error("The relay's /me answered no account.");
  return { userId: me.userId, email: me.email, name: (me.name || me.email.split("@")[0]!).split(" ")[0]! };
}

export async function liveRelayWorld(input: LiveRelayInput): Promise<JourneyWorld> {
  const relayUrl = relayBaseUrl(input.relayUrl);
  if (!relayUrl) throw new Error("SQUEAK_SMOKE_RELAY_URL is not a Catalyst relay address (https, no port).");
  const users = {
    owner: await whoIs(relayUrl, input.tokens.owner),
    invitee: await whoIs(relayUrl, input.tokens.invitee),
    member: await whoIs(relayUrl, input.tokens.member),
  };
  const tokenOf = new Map<string, string>([
    [users.owner.userId, input.tokens.owner],
    [users.invitee.userId, input.tokens.invitee],
    [users.member.userId, input.tokens.member],
  ]);
  const requests: Seen[] = [];
  const dirs: string[] = [];
  const owner = { id: "", away: false };
  const accountToken = async (user: TestUser) => tokenOf.get(user.userId)!;

  return {
    users,
    owner,
    requests,
    since: (from, who) => requests.slice(from).filter((r) => who === undefined || r.who === who),
    accountToken,
    web: (token, route, init = {}) =>
      fetch(`${relayUrl}${route}`, {
        method: init.method ?? "GET",
        headers: { "x-squeak-account": token, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    relayUrl,
    dirs,
    async mac(user, nest = `${user.name}-mac`, label = `${user.name}:${nest ?? "web"}`) {
      const provisioned = await fetch(`${relayUrl}/account/macs/provision`, {
        method: "POST",
        headers: { "x-squeak-account": await accountToken(user), "content-type": "application/json" },
        body: JSON.stringify({ macId: `mac${randomId(16)}`, name: `${user.name}'s smoke Mac` }),
      });
      if (provisioned.status !== 200) throw new Error(`The relay would not provision a Mac (${provisioned.status}).`);
      const { key } = (await provisioned.json()) as { key: string };
      return buildMac({
        user,
        nest,
        label,
        key,
        relayUrl,
        fetch: (url, init) => {
          requests.push({
            who: label,
            method: init?.method ?? "GET",
            route: new URL(url).pathname.replace(/^\/server\/squeak_relay/, ""),
          });
          return fetch(url, init);
        },
        owner,
        dirs,
      });
    },
  };
}
