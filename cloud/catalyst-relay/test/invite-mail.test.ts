// The invitation email (issue #132, docs/mocks/2026-11-26/invite-landing/email.png): what it says, and what it must never say.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;
const { buildInviteMail } = require(`${fn}mail.js`);

const URL_ = "https://squeak.onslate.in/invite?code=Zm9vYmFy";
const ADDRESS = "asha.lee@gmail.com";
const mail = (over: Record<string, unknown> = {}) =>
  buildInviteMail({
    inviterName: "Sibhi",
    pondName: "greenroom",
    email: ADDRESS,
    url: URL_,
    members: ["Sibhi", "Asha", "Dev"],
    expiresAt: Date.UTC(2026, 11, 3, 12),
    ...over,
  }) as { subject: string; text: string; html: string };

describe("invitation email", () => {
  it("has the subject from the spec", () => {
    expect(mail().subject).toBe("Sibhi invited you to greenroom on Squeak");
  });

  it("says what Squeak is and who is in the Pond, in both the text and the HTML", () => {
    for (const body of [mail().text, mail().html]) {
      expect(body).toContain("Squeak is where people and coding agents get work done together.");
      expect(body).toContain("Sibhi, Asha and Dev are already in greenroom.");
    }
  });

  it("has one Open invitation button to the invite page, and the bare link in the text", () => {
    const m = mail();
    expect(m.html.match(/href="/g)).toHaveLength(1);
    expect(m.html).toContain(`<a href="${URL_}"`);
    expect(m.html).toContain("Open invitation</a>");
    expect(m.text).toContain(`Open invitation: ${URL_}`);
  });

  it("says nothing needs installing and that the Mac app is optional", () => {
    expect(mail().text).toContain("You don't need to install anything to join.");
    expect(mail().html).toContain("You don&#39;t need to install anything to join.");
    for (const body of [mail().text, mail().html]) {
      expect(body).toContain("Squeak for Mac is optional.");
      expect(body).toContain("greenroom will be waiting");
      expect(body).toContain("It is also waiting in the Squeak app if you already have it.");
    }
  });

  it("names the masked address and the expiry date, and the full address nowhere", () => {
    const m = mail();
    for (const body of [m.text, m.html, m.subject]) {
      expect(body).not.toContain(ADDRESS);
      expect(body).not.toContain("asha.lee");
    }
    expect(m.text).toContain("This invitation is for a***@g***.com and expires on 3 December 2026.");
    expect(m.html).toContain("This invitation is for a***@g***.com and expires on 3 December 2026.");
  });

  it("carries no key and no code beyond the invite's own record id in the link", () => {
    const m = mail();
    const without = (body: string) => body.split(URL_).join("");
    for (const body of [without(m.text), without(m.html)]) {
      expect(body).not.toMatch(/\bcode\b/i);
      expect(body).not.toMatch(/key/i);
      expect(body).not.toMatch(/token/i);
    }
  });

  it("copes without members, an expiry or an inviter name, and escapes what people typed", () => {
    const bare = mail({ members: [], expiresAt: undefined, inviterName: "" });
    expect(bare.subject).toBe("Someone invited you to greenroom on Squeak");
    expect(bare.text).not.toContain("already in");
    expect(bare.text).toContain("This invitation is for a***@g***.com.");
    const rude = mail({ pondName: "<script>alert(1)</script>", inviterName: 'Evil"\nBcc: x' });
    expect(rude.html).not.toContain("<script>");
    expect(rude.subject).not.toContain("\n");
  });
});
