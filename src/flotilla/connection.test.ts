import { describe, expect, it } from "vitest";

import { connectionOf, overallConnection, ownerOfflineWord } from "./connection.js";

describe("the one connection state", () => {
  const base = { stream: "live" as const, reachable: true, owner: false, ownerOnline: true, ownerName: "Sibhi Raj" };

  it("is Live with a stream, a readable cloud and an Owner online", () => {
    expect(connectionOf(base)).toEqual({ state: "live", line: "Live" });
  });

  it("is Reconnecting while the stream is down (the 30 s poll is only the fallback)", () => {
    expect(connectionOf({ ...base, stream: "reconnecting" })).toEqual({
      state: "reconnecting",
      line: "Reconnecting…",
    });
  });

  it("is Reconnecting when the cloud cannot be read, whoever is offline", () => {
    expect(connectionOf({ ...base, reachable: false, ownerOnline: false }).state).toBe("reconnecting");
  });

  it("names the Owner's Mac when it is offline, from presence alone", () => {
    expect(connectionOf({ ...base, ownerOnline: false })).toEqual({
      state: "owner-offline",
      line: "Sibhi’s Mac offline",
    });
    expect(ownerOfflineWord(undefined)).toBe("The owner’s Mac offline");
  });

  it("never tells the Owner their own Mac is offline", () => {
    expect(connectionOf({ ...base, owner: true, ownerOnline: false }).state).toBe("live");
  });

  it("an unknown Owner presence is not offline", () => {
    expect(connectionOf({ ...base, ownerOnline: undefined }).state).toBe("live");
  });

  it("without squeak-live (the old path) the state follows what the cloud answered", () => {
    expect(connectionOf({ ...base, stream: null }).state).toBe("live");
    expect(connectionOf({ ...base, stream: null, reachable: false }).state).toBe("reconnecting");
  });

  it("transitions: live, reconnecting, live, owner away", () => {
    const seq = [
      connectionOf(base),
      connectionOf({ ...base, stream: "reconnecting" }),
      connectionOf(base),
      connectionOf({ ...base, ownerOnline: false }),
    ].map((c) => c.state);
    expect(seq).toEqual(["live", "reconnecting", "live", "owner-offline"]);
  });

  it("overall: reconnecting beats everything; Owner offline only when every other Pond's Owner is", () => {
    const live = { state: "live", line: "Live" } as const;
    const away = { state: "owner-offline", line: "Sibhi’s Mac offline" } as const;
    const re = { state: "reconnecting", line: "Reconnecting…" } as const;
    expect(overallConnection([])).toEqual(live);
    expect(
      overallConnection([
        { owner: true, connection: live },
        { owner: false, connection: away },
      ]).state,
    ).toBe("owner-offline");
    expect(
      overallConnection([
        { owner: false, connection: away },
        { owner: false, connection: live },
      ]).state,
    ).toBe("live");
    expect(
      overallConnection([
        { owner: false, connection: away },
        { owner: true, connection: re },
      ]).state,
    ).toBe("reconnecting");
    expect(overallConnection([{ owner: true }]).state).toBe("live");
  });
});
