import { describe, expect, it } from "vitest";

import { shape } from "../js/command-shapes.js";
import * as L from "../js/settings-channels-logic.js";
import * as vm from "../js/view-model.js";

const TOKEN = "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_-0123456";
const HOOK = "https://cliq.zoho.in/api/v2/bots/squeak/incoming?zapikey=SECRETKEY99";

const raw = (over = {}) => ({
  telegram: {
    tokenSet: true,
    bot: "squeak_bot",
    polling: "ok",
    lastError: null,
    chats: [
      { id: 5, name: "Me" },
      { id: -100, name: null },
    ],
    open: false,
    linking: null,
    testing: false,
    lastTest: null,
    ...over.telegram,
  },
  cliq: { webhookSet: true, ownerEmail: "me@x.com", ownerId: null, oneWay: true, twoWay: false, ...over.cliq },
  restarting: false,
});

describe("channelsSetup reader", () => {
  it("is null when absent or malformed (the UI hides)", () => {
    expect(vm.channelsSetup({})).toBeNull();
    expect(vm.channelsSetup({ channelsSetup: { telegram: {} } })).toBeNull();
    expect(vm.channelsSetup({ channelsSetup: "x" })).toBeNull();
  });

  it("reads the Mac's shape and drops junk entries", () => {
    const v = vm.channelsSetup({
      channelsSetup: raw({
        telegram: {
          chats: [{ id: 5, name: "Me" }, { id: 1.5 }, { id: 0 }, "x"],
          linking: {
            until: "2026-10-30T10:00:00Z",
            candidates: [{ id: 9, name: "Ann", type: "group" }, { id: "9" }, { id: 8, name: "Z", type: "weird" }],
          },
          lastTest: { at: "x", ok: false, sentTo: 0, reason: "boom" },
        },
      }),
    });
    expect(v.telegram.chats).toEqual([{ id: 5, name: "Me" }]);
    expect(v.telegram.linking.candidates).toEqual([
      { id: 9, name: "Ann", type: "group" },
      { id: 8, name: "Z", type: "private" },
    ]);
    expect(v.telegram.lastTest).toMatchObject({ ok: false, reason: "boom" });
    expect(v.cliq.oneWay).toBe(true);
  });
});

describe("validation", () => {
  it("accepts a token shape and says the Mac's sentence otherwise", () => {
    expect(L.looksLikeToken(` ${TOKEN} `)).toBe(true);
    expect(L.tokenProblem("")).toBeNull();
    expect(L.tokenProblem(TOKEN)).toBeNull();
    expect(L.tokenProblem("abc")).toBe(L.TOKEN_HELP);
  });
  it("checks the webhook and the owner", () => {
    expect(L.looksLikeWebhook(HOOK)).toBe(true);
    expect(L.webhookProblem("https://example.com/?zapikey=1")).toBe(L.WEBHOOK_HELP);
    expect(L.ownerInput(" me@x.com ", "")).toEqual({ email: "me@x.com", id: null });
    expect(L.ownerProblem("nope", "")).toMatch(/email/);
    expect(L.ownerProblem("", "bad id")).toMatch(/user ID/);
    expect(L.ownerProblem("a@b.c", "")).toBeNull();
    expect(L.ownerChanged({ ownerEmail: "me@x.com", ownerId: null }, "me@x.com", "")).toBe(false);
    expect(L.ownerChanged({ ownerEmail: "me@x.com", ownerId: null }, "", "")).toBe(true);
  });
});

describe("what the commands are", () => {
  it("every input the screen builds passes the strict shapes", () => {
    shape("telegram", L.telegramInput.token(` ${TOKEN} `));
    for (const key of ["off", "startLink", "stopLink", "test"]) shape("telegram", L.telegramInput[key]());
    shape("telegram", L.telegramInput.link(-5));
    shape("telegram", L.telegramInput.unlink(5));
    shape("cliq", L.cliqInput.webhook(` ${HOOK} `));
    shape("cliq", L.cliqInput.removeWebhook());
    shape("cliq", L.cliqInput.owner("", ""));
    shape("cliq", L.cliqInput.owner("me@x.com", " 12 "));
  });

  it("asks first for everything except test and the link window", () => {
    expect(L.needsConfirm("telegram", L.telegramInput.test())).toBe(false);
    expect(L.needsConfirm("telegram", L.telegramInput.startLink())).toBe(false);
    expect(L.needsConfirm("telegram", L.telegramInput.stopLink())).toBe(false);
    for (const input of [
      L.telegramInput.token(TOKEN),
      L.telegramInput.off(),
      L.telegramInput.link(1),
      L.telegramInput.unlink(1),
    ]) {
      expect(L.needsConfirm("telegram", input)).toBe(true);
    }
    expect(L.needsConfirm("cliq", L.cliqInput.removeWebhook())).toBe(true);
    expect(L.needsConfirm("cliq", L.cliqInput.owner(null, null))).toBe(true);
  });

  it("words the confirms like the Mac", () => {
    expect(L.confirmCopy({ type: "off" })).toMatchObject({
      question: "Turn off Telegram?",
      warning: "Squeak stops sending cards to Telegram. Your linked chats are kept.",
      yes: "Turn off and remove token",
    });
  });
});

describe("what to show", () => {
  it("telegram status", () => {
    const t = (o) => vm.channelsSetup({ channelsSetup: raw({ telegram: o }) }).telegram;
    expect(L.telegramStatus(t({ tokenSet: false }))).toMatchObject({ text: "Telegram is not set up" });
    expect(L.telegramStatus(t({}))).toMatchObject({ tone: "ok", text: "Connected as @squeak_bot" });
    expect(L.telegramStatus(t({ polling: "error", lastError: "nope" }))).toMatchObject({
      tone: "error",
      detail: "nope",
    });
    expect(L.telegramStatus(t({ polling: "off" })).text).toBe("Telegram is off");
  });

  it("cliq status", () => {
    expect(L.cliqStatus({ twoWay: true, oneWay: false }).text).toMatch(/^Two-way/);
    expect(L.cliqStatus({ twoWay: false, oneWay: true }).text).toMatch(/^One-way/);
    expect(L.cliqStatus({ twoWay: false, oneWay: false }).text).toBe("Zoho Cliq is not set up");
  });

  it("the link flow: hidden, waiting, a candidate, expired", () => {
    const t = (linking) => vm.channelsSetup({ channelsSetup: raw({ telegram: { linking } }) }).telegram;
    const now = Date.parse("2026-10-30T10:00:00Z");
    expect(L.linkPanel(t(null), false, now)).toBeNull();
    const waiting = L.linkPanel(t({ until: "2026-10-30T10:05:00Z", candidates: [] }), true, now);
    expect(waiting.steps[0]).toBe("1. Open Telegram and send any message to @squeak_bot.");
    expect(waiting).toMatchObject({ waiting: true, expired: false });
    const found = L.linkPanel(
      t({ until: "2026-10-30T10:05:00Z", candidates: [{ id: 9, name: "Ann", type: "private" }] }),
      true,
      now,
    );
    expect(found.candidates).toEqual([{ id: 9, name: "Ann", line: "Private chat · ID 9" }]);
    expect(L.linkPanel(t({ until: "2026-10-30T09:00:00Z", candidates: [] }), true, now).expired).toBe(true);
    expect(L.linkPanel(t(null), true, now).expired).toBe(true);
  });

  it("the test line", () => {
    expect(L.testLine(null)).toBeNull();
    expect(L.testLine({ ok: true, sentTo: 1 })).toBe("Sent to 1 chat.");
    expect(L.testLine({ ok: true, sentTo: 2 })).toBe("Sent to 2 chats.");
    expect(L.testLine({ ok: false, sentTo: 0, reason: "blocked" })).toBe("Not sent: blocked");
  });

  it("expects the Mac to go quiet while it restarts", () => {
    expect(L.quietIsExpected(false, 1000, 500)).toBe(true);
    expect(L.quietIsExpected(false, 1000, 1500)).toBe(false);
    expect(L.quietIsExpected(true, 0, 5)).toBe(true);
  });
});

describe("secrets", () => {
  it("never appear in anything the logic says or returns for display", () => {
    const outputs = [
      L.tokenProblem(TOKEN),
      L.tokenProblem(`${TOKEN}!`),
      L.webhookProblem(HOOK),
      L.webhookProblem(`${HOOK} x`),
      L.safeReason(`Mac said ${TOKEN} and ${HOOK}`),
      JSON.stringify(L.confirmCopy({ type: "token" })),
      JSON.stringify(L.confirmCopy({ type: "webhook" })),
    ];
    for (const out of outputs) {
      expect(String(out)).not.toContain(TOKEN);
      expect(String(out)).not.toContain("SECRETKEY99");
    }
  });

  it("the strict shape's refusals do not repeat them", () => {
    for (const [kind, change] of [
      ["telegram", { token: `${TOKEN}!` }],
      ["cliq", { webhook: "https://evil.example/x?zapikey=SECRETKEY99" }],
    ]) {
      try {
        shape(kind, { change });
        throw new Error("should refuse");
      } catch (e) {
        expect(e.message).not.toContain("SECRETKEY99");
        expect(e.message).not.toContain(TOKEN);
      }
    }
  });
});
