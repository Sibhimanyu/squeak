import { describe, expect, it } from "vitest";

import { databaseOrigin, parsePairingLink } from "../js/pairing-link.js";
import { deviceNameFor } from "../js/pairing.js";

const key = Buffer.alloc(32, 5).toString("base64");
const link = (payload) => `squeak://pair?d=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
const good = { v: 1, p: "squeak-5c9gvo", c: "p1pYhre8xC41Wr3hbYtgCg", k: key, n: "Sibhi's Mac" };

describe("databaseOrigin", () => {
  it("accepts a Realtime Database instance root and nothing else", () => {
    expect(databaseOrigin("https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app")).toBe(
      "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app",
    );
    expect(databaseOrigin("https://squeak-test.firebaseio.com/")).toBe("https://squeak-test.firebaseio.com");
    expect(databaseOrigin("https://SQUEAK-TEST.FIREBASEIO.COM")).toBe("https://squeak-test.firebaseio.com");
  });

  it("rejects other schemes, hosts, credentials, ports, paths and queries", () => {
    for (const bad of [
      "http://a.firebasedatabase.app",
      "https://evil.example",
      "https://firebasedatabase.app",
      "https://a.firebasedatabase.app.evil.example",
      "https://evil.example#.firebasedatabase.app",
      "https://evil.example\\@a.firebasedatabase.app",
      "https://a.firebasedatabase.app@evil.example",
      "https://user:pw@a.firebasedatabase.app",
      "https://a.firebasedatabase.app:8443",
      "https://a.firebasedatabase.app/x",
      "https://a.firebasedatabase.app/?ns=x",
      "https://a.firebasedatabase.app/#x",
      "javascript:alert(1)",
      "//a.firebasedatabase.app",
      "",
      null,
      42,
    ]) {
      expect(databaseOrigin(bad), String(bad)).toBeNull();
    }
  });
});

describe("parsePairingLink", () => {
  it("reads what the Mac's QR code carries", () => {
    const parsed = parsePairingLink(
      `  ${link({ ...good, r: "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app" })}\n`,
    );
    expect(parsed).toEqual({
      project: "squeak-5c9gvo",
      channelId: good.c,
      key,
      macName: "Sibhi's Mac",
      databaseUrl: "https://squeak-test-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
  });

  it("returns no database for a code from before the move", () => {
    expect(parsePairingLink(link(good)).databaseUrl).toBeNull();
  });

  it("refuses a code that would aim the browser at another server", () => {
    expect(() => parsePairingLink(link({ ...good, r: "https://evil.example" }))).toThrow(/server/);
  });

  it.each([
    ["not a link", "hello"],
    ["another scheme", "https://pair?d=abc"],
    ["another host", `squeak://open?d=${Buffer.from("{}").toString("base64url")}`],
    ["no payload", "squeak://pair"],
    ["not base64url", "squeak://pair?d=%%%"],
    ["not JSON", `squeak://pair?d=${Buffer.from("nope").toString("base64url")}`],
    ["a version it does not know", link({ ...good, v: 2 })],
    ["a short key", link({ ...good, k: Buffer.alloc(16).toString("base64") })],
    ["a key that is not base64", link({ ...good, k: "!!!" })],
    ["a channel id with a slash", link({ ...good, c: "aaaaaaaaaaaaaaaaaaaa/../x" })],
    ["a short channel id", link({ ...good, c: "short" })],
    ["no Mac name", link({ ...good, n: undefined })],
  ])("refuses %s", (_name, text) => {
    expect(() => parsePairingLink(text)).toThrow();
  });
});

describe("deviceNameFor", () => {
  it("names the browser for the Mac's device list", () => {
    expect(deviceNameFor("Mozilla/5.0 Chrome/120 Safari/537")).toBe("Web · Chrome");
    expect(deviceNameFor("Mozilla/5.0 Version/17 Safari/605")).toBe("Web · Safari");
    expect(deviceNameFor("Mozilla/5.0 Firefox/120")).toBe("Web · Firefox");
    expect(deviceNameFor("Mozilla/5.0 Chrome/120 Edg/120")).toBe("Web · Edge");
    expect(deviceNameFor("")).toBe("Web · browser");
  });
});
