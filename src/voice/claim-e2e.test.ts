import { afterEach, describe, expect, it } from "vitest";

import { FakeRtdb } from "../remote/fake-rtdb.js";
import { RtdbRest } from "../remote/rtdb-rest.js";
import { claimWithMac } from "./addon-claim.js";
import { GatewayClaim } from "./gateway-claim.js";

const DB = "https://squeak-x-default-rtdb.asia-southeast1.firebasedatabase.app";

const fakes: FakeRtdb[] = [];
async function rendezvous(): Promise<RtdbRest> {
  const fake = new FakeRtdb();
  fakes.push(fake);
  return new RtdbRest(await fake.start());
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((fake) => fake.stop()));
});

describe("claiming the add-on from the Mac, both real sides on one rendezvous", () => {
  it("the add-on's code, typed loosely on the Mac, gets the Mac's database, channel and key to the add-on", async () => {
    const shared = await rendezvous();
    let shown = "";
    const saved: Array<{ channel: string; key: string }> = [];
    let restarted = 0;

    const addon = claimWithMac({
      store: shared,
      now: Date.now,
      version: "0.9.0",
      name: "Squeak Voice",
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      onCode: (code) => (shown = code),
      pollMs: 5,
    });

    while (!shown) await new Promise((resolve) => setTimeout(resolve, 5));
    // A request is only written once the code is shown; give the loop a beat to write it.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const mac = new GatewayClaim({
      store: shared,
      databaseUrl: DB,
      current: () => null,
      save: (channel, key) => saved.push({ channel, key }),
      restart: () => (restarted += 1),
      pollMs: 5,
      cleanupMs: 5,
      restartMs: 1,
    });
    const started = await mac.start(shown.toLowerCase().replace("-", " "));
    expect(started).toMatchObject({ ok: true, name: "Squeak Voice", version: "0.9.0" });
    expect(mac.view()?.state).toBe("request");
    expect(await mac.approve(true)).toEqual({ ok: true });

    const grant = await addon;
    expect(grant.databaseUrl).toBe(DB);
    expect(saved).toHaveLength(1);
    expect(grant.channel).toBe(saved[0]!.channel);
    expect(grant.key).toBe(saved[0]!.key);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(restarted).toBe(1);
  });

  it("a code that is not showing is refused", async () => {
    const mac = new GatewayClaim({
      store: await rendezvous(),
      databaseUrl: DB,
      current: () => null,
      save: () => undefined,
      restart: () => undefined,
    });
    expect(await mac.start("K7M2-QX9P")).toMatchObject({ ok: false, status: 400 });
  });
});
