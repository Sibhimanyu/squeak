// The People and remote journey on the relay double (issue #134): the real relay handler with its people tables, change feed,
// blob bucket and live hub in memory, an Owner's Mac, an invitee on the web and on a second Mac, and another Member. The steps
// live in people-journey.test-fixture.ts and run daily against a real development relay (scripts/smoke-people.ts).
// This area does not ship while it is red: it runs with every other test, so every change to src/flotilla, src/cloud,
// cloud/catalyst-relay and webapp is judged by it.
import { afterAll, describe, it } from "vitest";

import { peopleJourney } from "./people-journey.test-fixture.js";
import { RelayWorld } from "./relay-world.test-fixture.js";

process.env.SQUEAK_POND_OWN_THREADS = "on";

const relay = await RelayWorld.start();
afterAll(() => relay.stop());

describe("the People and remote journey over the relay double", () => {
  peopleJourney(
    {
      users: {
        owner: { userId: "u-sibhi", email: "sibhi@example.com", name: "Sibhi" },
        invitee: { userId: "u-asha", email: "asha@example.com", name: "Asha" },
        member: { userId: "u-bea", email: "bea@example.com", name: "Bea" },
      },
      owner: relay.owner,
      requests: relay.requests,
      since: (from, who) => relay.since(from, who),
      mac: (user, nest, label) => relay.mac(user, nest, label),
      accountToken: (user) => relay.accountToken(user),
      web: (token, route, init) => relay.web(token, route, init),
      relayUrl: relay.relayUrl,
      dirs: relay.dirs,
      double: relay.double,
    },
    (name, run) => it(name, run, 60_000),
  );
});
