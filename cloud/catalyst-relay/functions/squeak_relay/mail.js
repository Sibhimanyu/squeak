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

/** { subject, text, html } for one recipient. Catalyst Mail sends one body, so the sender uses `html`; `text` carries the same words. */
function buildInviteMail({ inviterName, pondName, email, url }) {
  const inviter = oneLine(inviterName, 100) || "Someone";
  const pond = oneLine(pondName, 100) || "a pond";
  const subject = `${inviter} invited you to ${pond} on Squeak`;
  const intro = `${inviter} wants you in ${pond}, a shared space where you and their coding agents work together on Squeak.`;
  const how = `Open the link and sign in with ${email}. No install needed: it works in your browser, and you can add the Mac app later.`;
  const footer = `You got this because ${inviter} typed your address into Squeak. If you weren't expecting it, ignore this email.`;
  const text = `${intro}\n\nJoin ${pond}: ${url}\n\n${how}\n\n${footer}\n`;
  const html =
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#18181b;max-width:480px">` +
    `<p>${escapeHtml(intro)}</p>` +
    `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#facc15;color:#18181b;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">Join ${escapeHtml(pond)}</a></p>` +
    `<p>${escapeHtml(how)}</p>` +
    `<p style="font-size:13px;color:#52525b">${escapeHtml(`Or paste this into your browser: ${url}`)}</p>` +
    `<p style="font-size:13px;color:#52525b">${escapeHtml(footer)}</p></div>`;
  return { subject, text, html };
}

module.exports = { EMAIL_STRICT, normEmail, validEmail, maskEmail, buildInviteMail };
