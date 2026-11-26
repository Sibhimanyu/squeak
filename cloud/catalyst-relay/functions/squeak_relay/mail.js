// Pond invitation email (docs/ponds.md, "Invite by email"; docs/cloud-layer.md, "Invite email"). Pure helpers: the Catalyst Mail
// SDK is wired in index.js and nowhere else, and tests pass a fake sender. Plain words, no tracking pixel, no analytics link.

/** A simple strict address: no spaces, quotes or comments, one @, a dotted host. Max 254 characters overall. */
const EMAIL_STRICT =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const normEmail = (e) => String(e).trim().toLowerCase();
const validEmail = (e) => typeof e === "string" && e.length <= 254 && EMAIL_STRICT.test(e.trim());

/** "pat.lee@example.com" -> "p***@e***.com": enough to recognise your own address, not to learn somebody else's. */
function maskEmail(email) {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return "***";
  const local = e.slice(0, at);
  const host = e.slice(at + 1);
  const dot = host.lastIndexOf(".");
  const name = dot > 0 ? host.slice(0, dot) : host;
  const tld = dot > 0 ? host.slice(dot) : "";
  return `${local[0]}***@${name[0] || ""}***${tld}`;
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
/** One line of text with no control characters (a header must never be able to carry a newline). */
const CONTROL = new RegExp("[\\x00-\\x1f\\x7f\\u2028\\u2029]+", "g");
const oneLine = (s, max) => String(s).replace(CONTROL, " ").trim().slice(0, max);

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** "3 December 2026" (UTC, so every reader sees the same day). */
const longDate = (epochMs) => {
  const d = new Date(epochMs);
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "";
};
/** "Sibhi", "Sibhi and Asha", "Sibhi, Asha and Dev". */
const nameList = (names) =>
  names.length <= 1 ? names[0] || "" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
/** The same hue the apps give a name (fnv-1a, never in the duck's yellow band 25..75), for the initial discs. */
function hueOf(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  const x = h % 310;
  return x < 25 ? x : x + 50;
}
const disc = (name, size, radius) =>
  `<span style="display:inline-block;width:${size}px;height:${size}px;line-height:${size}px;text-align:center;border-radius:${radius};background:hsl(${hueOf(name)},55%,90%);color:hsl(${hueOf(name)},55%,26%);font-weight:700;font-size:${Math.round(size * 0.42)}px;border:2px solid #ffffff;margin-right:-8px">${escapeHtml((name.trim().charAt(0) || "?").toUpperCase())}</span>`;

/**
 * { subject, text, html } for one recipient (docs/mocks/2026-11-26/invite-landing/email.png). Catalyst Mail sends one body, so the
 * sender uses `html`; `text` carries the same words. Nothing here is a key, a code or the full address: the recipient's own address is
 * the To line only and the body shows it masked. `url` is the invite page (its query is the invite's record id, which grants nothing by
 * itself: joining needs a sign-in with the invited address). `members` are first names, `expiresAt` is epoch ms.
 */
function buildInviteMail({
  inviterName,
  pondName,
  email,
  url,
  members = [],
  expiresAt,
  assetBase = "https://squeak.onslate.in",
}) {
  const inviter = oneLine(inviterName, 100) || "Someone";
  const pond = oneLine(pondName, 100) || "a Pond";
  const masked = maskEmail(email);
  const names = members
    .map((m) => oneLine(m, 100))
    .filter(Boolean)
    .slice(0, 10);
  const subject = `${inviter} invited you to ${pond} on Squeak`;
  const date = expiresAt ? longDate(expiresAt) : "";
  const who = names.length > 0 ? ` ${nameList(names)} ${names.length === 1 ? "is" : "are"} already in ${pond}.` : "";
  const intro = `Squeak is where people and coding agents get work done together.${who}`;
  const noInstall = "You don't need to install anything to join.";
  const how = "Open the invitation and sign up in your browser.";
  const optionalLead = "Squeak for Mac is optional.";
  const optionalRest = `If you want it later, sign in with this address and ${pond} will be waiting. It is also waiting in the Squeak app if you already have it.`;
  const foot = `This invitation is for ${masked}${date ? ` and expires on ${date}` : ""}.`;
  const ignore = "If you were not expecting it, you can ignore this email.";
  const text = `${inviter} invited you to ${pond}\n\n${intro}\n\nOpen invitation: ${url}\n\n${noInstall}\n${how}\n\n${optionalLead} ${optionalRest}\n\n${foot}\n${ignore}\n`;
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const hue = hueOf(pond);
  const html =
    `<div style="background:#eeede9;padding:24px 12px;font-family:${font};color:#292622">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:24px;overflow:hidden">` +
    `<div style="background:hsl(${hue},45%,94%);padding:32px 32px 28px">` +
    `<p style="margin:0 0 24px;font-size:18px;font-weight:700"><img src="${escapeHtml(assetBase)}/brand/squeak-duck-full-color-96.png" width="32" height="32" alt="" style="vertical-align:middle;margin-right:8px;border:0">Squeak</p>` +
    `<p style="margin:0 0 20px">${disc(pond, 44, "12px")}<span style="display:inline-block;width:20px"></span>${names
      .slice(0, 3)
      .map((n) => disc(n, 36, "50%"))
      .join("")}</p>` +
    `<h1 style="margin:0;font-size:30px;line-height:1.15;font-weight:700">${escapeHtml(inviter)} invited you to <span style="color:hsl(${hue},55%,26%)">${escapeHtml(pond)}</span></h1>` +
    `</div>` +
    `<div style="padding:28px 32px 8px">` +
    `<p style="margin:0 0 24px;font-size:17px;line-height:1.55;color:#67625e">${escapeHtml(intro)}</p>` +
    `<p style="margin:0 0 20px"><a href="${escapeHtml(url)}" style="display:block;background:#292622;color:#ffffff;text-decoration:none;font-weight:600;font-size:17px;text-align:center;padding:16px 20px;border-radius:14px">Open invitation</a></p>` +
    `<p style="margin:0 0 24px;text-align:center;font-size:15px;line-height:1.5;color:#67625e"><strong style="color:#292622">${escapeHtml(noInstall)}</strong><br>${escapeHtml(how)}</p>` +
    `<p style="margin:0 0 28px;padding:16px 18px;background:#faf6f0;border-radius:14px;font-size:15px;line-height:1.55;color:#67625e"><strong style="color:#292622">${escapeHtml(optionalLead)}</strong> ${escapeHtml(optionalRest)}</p>` +
    `</div>` +
    `<div style="border-top:1px solid #e7e2dd;padding:20px 32px 28px;font-size:13px;line-height:1.6;color:#8a847f">${escapeHtml(foot)}<br>${escapeHtml(ignore)}</div>` +
    `</div></div>`;
  return { subject, text, html };
}

module.exports = { EMAIL_STRICT, normEmail, validEmail, maskEmail, buildInviteMail };
