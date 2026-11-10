import { describe, expect, it } from "vitest";

import { EMPTY_CATALYST, GUEST_JOIN_PATH, guestInviteBase } from "./config.js";

describe("a web guest's invite link comes from the Catalyst app domain", () => {
  it("is <appUrl>/app/index.html, with the code left to ride in the fragment", () => {
    expect(GUEST_JOIN_PATH).toBe("/app/index.html");
    expect(guestInviteBase({ ...EMPTY_CATALYST, appUrl: "https://squeak-1234.catalystserverless.in/" })).toBe(
      "https://squeak-1234.catalystserverless.in/app/index.html",
    );
  });

  it("is null until deployed, and for a host that is not Catalyst's", () => {
    expect(guestInviteBase(null)).toBeNull();
    expect(guestInviteBase(EMPTY_CATALYST)).toBeNull();
    expect(guestInviteBase({ ...EMPTY_CATALYST, appUrl: "https://evil.example.com" })).toBeNull();
  });
});
