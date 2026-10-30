// Settings > Channels: Telegram and Zoho Cliq setup from the browser, the way the Mac app's Settings > Channels does
// it. Drawn only when the Mac's view carries `channelsSetup` (an older Mac hides it). A secret (bot token, webhook)
// lives only in a field's own DOM value: typed or pasted once, read when the person confirms, cleared before the
// send starts, never copied into state, storage, the address, a log, an error line or any retry. The page redraws
// whole on every view refresh, so those two fields are kept as DOM nodes (not strings) and put back each time.

import { h } from "./dom.js";
import { liveness } from "./mac-strip.js";
import { OWNER_CHECK_NOTE } from "./settings-mac-logic.js";
import { S as MacState, pressAvatar, run } from "./settings-mac-parts.js";
import {
  CHATS_FOOTNOTE,
  OPEN_WARNING,
  OWNER_FOOTNOTE,
  RESTART_QUIET_MS,
  SAVE_RESTARTS,
  TOKEN_FOOTNOTE,
  WEBHOOK_FOOTNOTE,
  chatRows,
  cliqInput,
  cliqStatus,
  confirmCopy,
  linkPanel,
  looksLikeToken,
  looksLikeWebhook,
  ownerChanged,
  ownerProblem,
  quietIsExpected,
  safeReason,
  telegramInput,
  telegramStatus,
  testLine,
  tokenProblem,
  webhookProblem,
} from "./settings-channels-logic.js";
import * as view from "./view-model.js";

/** Plain, non-secret state. Never holds a token or a webhook. */
export const C = {
  confirm: null, // { type, name?, id? }
  busy: false,
  changingToken: false,
  changingWebhook: false,
  linkOpen: false,
  ownerEmail: null,
  ownerId: null,
  quietUntil: 0,
  testing: false,
  tokenOk: false,
  webhookOk: false,
  pasteNote: null,
};

/** The secret fields' DOM nodes: the only place a secret exists, until it is sent. */
const fields = { token: null, webhook: null };

function secretField(name, id, label, placeholder, onchange) {
  if (!fields[name]) {
    fields[name] = h("input", {
      id,
      class: "sm-input wide",
      type: "password",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      "aria-label": label,
      placeholder,
      "data-keep": id,
    });
    fields[name].addEventListener("input", () => onchange(fields[name].value));
  }
  return fields[name];
}

function wipe(name) {
  if (fields[name]) fields[name].value = "";
}

async function paste(name, ctx, check) {
  C.pasteNote = null;
  try {
    const text = await globalThis.navigator.clipboard.readText();
    if (fields[name]) {
      fields[name].value = text;
      check(text);
    }
  } catch {
    C.pasteNote = "Couldn't read the clipboard. Paste into the field instead.";
  }
  ctx.touch();
}

const quietNow = (ctx) => {
  const live = liveness({ aliveAt: ctx.sync?.state?.aliveAt, lookingSince: undefined, now: Date.now() });
  return live.kind === "silent" && !quietIsExpected(view.channelsSetup(ctx.view)?.restarting, C.quietUntil);
};

/** Sends one change. The caller has cleared any secret from its field already. */
async function send(ctx, kind, input, area, { restarts = false } = {}) {
  C.busy = true;
  ctx.touch();
  const out = await run(ctx, kind, input, area);
  C.busy = false;
  if (out.ok && restarts) C.quietUntil = Date.now() + RESTART_QUIET_MS;
  MacState.problems[area] = out.ok ? null : safeReason(out.reason);
  ctx.touch();
  return out;
}

/** Runs a confirmed action. Reads a secret out of its field and empties the field before anything is sent. */
async function perform(ctx, action) {
  C.confirm = null;
  switch (action.type) {
    case "token": {
      const value = fields.token?.value ?? "";
      wipe("token");
      C.tokenOk = false;
      if (!looksLikeToken(value)) return ctx.touch();
      const out = await send(ctx, "telegram", telegramInput.token(value), "tg", { restarts: true });
      if (out.ok) C.changingToken = false;
      return;
    }
    case "webhook": {
      const value = fields.webhook?.value ?? "";
      wipe("webhook");
      C.webhookOk = false;
      if (!looksLikeWebhook(value)) return ctx.touch();
      const out = await send(ctx, "cliq", cliqInput.webhook(value), "cliq", { restarts: true });
      if (out.ok) C.changingWebhook = false;
      return;
    }
    case "off":
      await send(ctx, "telegram", telegramInput.off(), "tg", { restarts: true });
      return;
    case "link": {
      const out = await send(ctx, "telegram", telegramInput.link(action.id), "tg", { restarts: true });
      if (out.ok) C.linkOpen = false;
      return;
    }
    case "unlink":
      await send(ctx, "telegram", telegramInput.unlink(action.id), "tg", { restarts: true });
      return;
    case "removeWebhook":
      await send(ctx, "cliq", cliqInput.removeWebhook(), "cliq", { restarts: true });
      return;
    default: {
      const out = await send(ctx, "cliq", cliqInput.owner(C.ownerEmail, C.ownerId), "cliq", { restarts: true });
      if (out.ok) {
        C.ownerEmail = null;
        C.ownerId = null;
      }
    }
  }
}

const ask = (ctx, action) => {
  C.confirm = action;
  MacState.problems.tg = null;
  MacState.problems.cliq = null;
  ctx.touch();
};

function confirmBox(ctx, action) {
  const copy = confirmCopy(action);
  return h(
    "div",
    { class: "sm-block", role: "group", "aria-label": copy.question },
    h("strong", { class: "sm-sub" }, copy.question),
    h("p", { class: "note" }, copy.warning),
    h("p", { class: "note" }, OWNER_CHECK_NOTE),
    h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        { class: "btn danger", type: "button", disabled: C.busy, onclick: () => void perform(ctx, action) },
        copy.yes,
      ),
      h("button", { class: "btn quiet", type: "button", onclick: () => ((C.confirm = null), ctx.touch()) }, "Cancel"),
    ),
  );
}

const confirming = (type) => C.confirm?.type === type;
const note = (text, cls = "note") =>
  text ? h("p", { class: cls, role: cls === "note" ? undefined : "status" }, text) : null;
const problem = (area) => note(MacState.problems[area], "note sm-problem");

function statusCard(tone, text, detail) {
  return h(
    "div",
    { class: "sm-card" },
    h(
      "div",
      { class: "sm-card-main" },
      h(
        "div",
        { class: "sm-card-title" },
        h("strong", null, "Status"),
        h(
          "span",
          { class: "sm-pill" },
          h("span", {
            class: `dot d-${tone === "ok" ? "working" : tone === "error" ? "error" : "idle"}`,
            "aria-hidden": "true",
          }),
        ),
      ),
      h("p", { class: "sm-glance" }, text),
      detail ? h("p", { class: "note" }, safeReason(detail)) : null,
    ),
  );
}

/* ---------- Telegram ---------- */

function tokenBlock(ctx, t, off) {
  if (t.tokenSet && !C.changingToken) {
    return h(
      "div",
      { class: "sm-block" },
      h("strong", { class: "sm-sub" }, "Bot token"),
      h(
        "div",
        { class: "row-actions" },
        h("span", { class: "note" }, "Set"),
        h(
          "button",
          { class: "btn", type: "button", disabled: off, onclick: () => ((C.changingToken = true), ctx.touch()) },
          "Change",
        ),
      ),
    );
  }
  const input = secretField("token", "sc-token", "Bot token", "123456789:ABC…", (value) => {
    const ok = looksLikeToken(value);
    const btn = globalThis.document?.getElementById("sc-token-save");
    if (btn) btn.disabled = !ok || C.busy;
    const line = globalThis.document?.getElementById("sc-token-help");
    if (line) line.textContent = tokenProblem(value) ?? "";
    C.tokenOk = ok;
  });
  const ready = looksLikeToken(input.value);
  return h(
    "div",
    { class: "sm-block" },
    h("label", { class: "sm-label", for: "sc-token" }, "Bot token"),
    h(
      "div",
      { class: "row-actions" },
      input,
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          disabled: off,
          onclick: () => void paste("token", ctx, (v) => (C.tokenOk = looksLikeToken(v))),
        },
        "Paste",
      ),
    ),
    h("p", { class: "note sm-problem", id: "sc-token-help" }, tokenProblem(input.value) ?? ""),
    confirming("token")
      ? confirmBox(ctx, C.confirm)
      : h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              id: "sc-token-save",
              disabled: !ready || off,
              onclick: () => ask(ctx, { type: "token" }),
            },
            "Save",
          ),
          t.tokenSet
            ? h(
                "button",
                {
                  class: "btn quiet",
                  type: "button",
                  onclick: () => {
                    wipe("token");
                    C.changingToken = false;
                    ctx.touch();
                  },
                },
                "Cancel",
              )
            : null,
        ),
    note(TOKEN_FOOTNOTE),
  );
}

function chatsBlock(ctx, t, off) {
  const rows = chatRows(t);
  const panel = linkPanel(t, C.linkOpen);
  return h(
    "div",
    { class: "sm-block" },
    h("strong", { class: "sm-sub" }, "Allowed chats"),
    rows.length === 0 ? h("p", { class: "note" }, "No chats linked") : null,
    rows.map((r) =>
      h(
        "div",
        { class: "row-actions", "data-chat": String(r.id) },
        h("span", null, h("strong", null, r.name), " ", h("span", { class: "note" }, r.line)),
        h(
          "button",
          {
            class: "btn quiet",
            type: "button",
            disabled: off,
            "aria-label": `Remove chat ${r.name}`,
            title: "Remove this chat",
            onclick: () => ask(ctx, { type: "unlink", id: r.id, name: r.name === "Chat" ? null : r.name }),
          },
          "Remove",
        ),
      ),
    ),
    confirming("unlink") || confirming("link") ? confirmBox(ctx, C.confirm) : null,
    panel ? linkSheet(ctx, panel, off) : null,
    panel
      ? null
      : h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: !t.tokenSet || off,
            onclick: async () => {
              C.linkOpen = true;
              await send(ctx, "telegram", telegramInput.startLink(), "tg");
              if (MacState.problems.tg) C.linkOpen = false;
              ctx.touch();
            },
          },
          "Link a chat…",
        ),
    t.open && rows.length === 0 ? note(OPEN_WARNING) : note(CHATS_FOOTNOTE),
  );
}

function linkSheet(ctx, panel, off) {
  return h(
    "div",
    { class: "sm-block", role: "group", "aria-label": "Link a chat" },
    h("strong", { class: "sm-sub" }, "Link a chat"),
    panel.steps.map((s) => h("p", { class: "note" }, s)),
    note(panel.saveFirst),
    panel.waiting ? h("p", { class: "note", role: "status" }, "Waiting for a message…") : null,
    panel.expired ? h("p", { class: "note" }, "The link window closed. Press Link a chat to start again.") : null,
    panel.candidates.map((c) =>
      h(
        "div",
        { class: "row-actions", "data-candidate": String(c.id) },
        h("span", null, h("strong", null, c.name), " ", h("span", { class: "note" }, c.line)),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: off || C.busy,
            onclick: () => ask(ctx, { type: "link", id: c.id, name: c.name === "Chat" ? null : c.name }),
          },
          "Link",
        ),
      ),
    ),
    h(
      "div",
      { class: "row-actions" },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          onclick: async () => {
            C.linkOpen = false;
            C.confirm = null;
            if (panel.active) await send(ctx, "telegram", telegramInput.stopLink(), "tg");
            else ctx.touch();
          },
        },
        "Done",
      ),
    ),
  );
}

function telegramBlock(ctx, v) {
  const t = v.telegram;
  const off = v.restarting || C.busy;
  const status = telegramStatus(t);
  const line = testLine(t.lastTest);
  return h(
    "div",
    { class: "sm-channel" },
    h("h3", null, "Telegram"),
    statusCard(status.tone, status.text, status.detail),
    tokenBlock(ctx, t, off),
    chatsBlock(ctx, t, off),
    view.telegramAvatar(ctx.view) === true
      ? h(
          "div",
          { class: "sm-block" },
          h("strong", { class: "sm-sub" }, "Bot picture"),
          h(
            "button",
            {
              class: "btn",
              type: "button",
              disabled: MacState.avatar.sending || Date.now() < MacState.avatar.lockedUntil,
              onclick: () => void pressAvatar(ctx),
            },
            MacState.avatar.sending ? "Setting…" : "Use Squeak logo",
          ),
          note(MacState.avatar.line, "note sm-problem"),
        )
      : null,
    h(
      "div",
      { class: "sm-block" },
      h("strong", { class: "sm-sub" }, "Save & test"),
      h(
        "div",
        { class: "row-actions" },
        h(
          "button",
          {
            class: "btn",
            type: "button",
            disabled: !t.tokenSet || t.chats.length === 0 || t.testing || C.busy,
            onclick: () => void send(ctx, "telegram", telegramInput.test(), "tg"),
          },
          t.testing ? "Sending…" : "Send test message",
        ),
        t.tokenSet
          ? h(
              "button",
              { class: "btn danger", type: "button", disabled: off, onclick: () => ask(ctx, { type: "off" }) },
              "Turn off…",
            )
          : null,
      ),
      confirming("off") ? confirmBox(ctx, C.confirm) : null,
      note(line),
      note(SAVE_RESTARTS),
    ),
    problem("tg"),
  );
}

/* ---------- Cliq ---------- */

function webhookBlock(ctx, c, off) {
  if (c.webhookSet && !C.changingWebhook) {
    return h(
      "div",
      { class: "sm-block" },
      h("strong", { class: "sm-sub" }, "Webhook URL"),
      h(
        "div",
        { class: "row-actions" },
        h("span", { class: "note" }, "Set"),
        h(
          "button",
          { class: "btn", type: "button", disabled: off, onclick: () => ((C.changingWebhook = true), ctx.touch()) },
          "Change",
        ),
        h(
          "button",
          { class: "btn danger", type: "button", disabled: off, onclick: () => ask(ctx, { type: "removeWebhook" }) },
          "Remove webhook",
        ),
      ),
      confirming("removeWebhook") ? confirmBox(ctx, C.confirm) : null,
    );
  }
  const input = secretField("webhook", "sc-webhook", "Webhook URL", "https://cliq.zoho.in/…", (value) => {
    const ok = looksLikeWebhook(value);
    const btn = globalThis.document?.getElementById("sc-webhook-save");
    if (btn) btn.disabled = !ok || C.busy;
    const help = globalThis.document?.getElementById("sc-webhook-help");
    if (help) help.textContent = webhookProblem(value) ?? "";
    C.webhookOk = ok;
  });
  return h(
    "div",
    { class: "sm-block" },
    h("label", { class: "sm-label", for: "sc-webhook" }, "Webhook URL"),
    h(
      "div",
      { class: "row-actions" },
      input,
      h(
        "button",
        {
          class: "btn quiet",
          type: "button",
          disabled: off,
          onclick: () => void paste("webhook", ctx, (v) => (C.webhookOk = looksLikeWebhook(v))),
        },
        "Paste",
      ),
    ),
    h("p", { class: "note sm-problem", id: "sc-webhook-help" }, webhookProblem(input.value) ?? ""),
    confirming("webhook")
      ? confirmBox(ctx, C.confirm)
      : h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              id: "sc-webhook-save",
              disabled: !looksLikeWebhook(input.value) || off,
              onclick: () => ask(ctx, { type: "webhook" }),
            },
            "Save",
          ),
          c.webhookSet
            ? h(
                "button",
                {
                  class: "btn quiet",
                  type: "button",
                  onclick: () => {
                    wipe("webhook");
                    C.changingWebhook = false;
                    ctx.touch();
                  },
                },
                "Cancel",
              )
            : null,
        ),
    note(WEBHOOK_FOOTNOTE),
  );
}

function ownerBlock(ctx, c, off) {
  const email = C.ownerEmail ?? c.ownerEmail ?? "";
  const id = C.ownerId ?? c.ownerId ?? "";
  const bad = ownerProblem(email, id);
  const changed = ownerChanged(c, email, id);
  const field = (label, key, value, placeholder, name) =>
    h(
      "div",
      { class: "sm-block" },
      h("label", { class: "sm-label", for: `sc-${key}` }, label),
      h("input", {
        id: `sc-${key}`,
        class: "sm-input wide",
        type: "text",
        autocomplete: "off",
        spellcheck: "false",
        placeholder,
        value,
        "data-keep": `sc-${key}`,
        oninput: (e) => {
          C[name] = e.target.value;
          const b = globalThis.document?.getElementById("sc-owner-save");
          const next = ownerProblem(
            name === "ownerEmail" ? e.target.value : email,
            name === "ownerId" ? e.target.value : id,
          );
          const nowChanged = ownerChanged(
            c,
            name === "ownerEmail" ? e.target.value : email,
            name === "ownerId" ? e.target.value : id,
          );
          if (b) b.disabled = next !== null || !nowChanged || C.busy;
        },
      }),
    );
  return h(
    "div",
    { class: "sm-channel" },
    h("h3", null, "Owner"),
    field("Owner email", "owner-email", email, "you@company.com", "ownerEmail"),
    field("Owner ID", "owner-id", id, "Cliq user ID", "ownerId"),
    note(bad, "note sm-problem"),
    confirming("owner")
      ? confirmBox(ctx, C.confirm)
      : h(
          "div",
          { class: "row-actions" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              id: "sc-owner-save",
              disabled: bad !== null || !changed || off,
              onclick: () => ask(ctx, { type: "owner" }),
            },
            "Save",
          ),
        ),
    note(changed ? `${OWNER_FOOTNOTE} ${SAVE_RESTARTS}` : OWNER_FOOTNOTE),
  );
}

function cliqBlock(ctx, v) {
  const c = v.cliq;
  const off = v.restarting || C.busy;
  const status = cliqStatus(c);
  return h(
    "div",
    { class: "sm-channel" },
    h("h3", null, "Zoho Cliq"),
    statusCard(status.tone, status.text, null),
    webhookBlock(ctx, c, off),
    ownerBlock(ctx, c, off),
    note(C.pasteNote),
    problem("cliq"),
  );
}

export function channelsSection(ctx) {
  const v = view.channelsSetup(ctx.view);
  if (!v) return null;
  return [
    quietNow(ctx) ? h("p", { class: "note" }, "Your Mac isn't answering. Changes won't reach it.") : null,
    v.restarting ? h("p", { class: "note", role: "status" }, "Restarting the Squeak service…") : null,
    telegramBlock(ctx, v),
    cliqBlock(ctx, v),
  ].filter(Boolean);
}
