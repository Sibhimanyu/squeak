import fs from "node:fs";

import { parseCliqWebhookUrl } from "./client.js";
import { CLIQ_INBOX_DATABASE, CLIQ_INBOX_FIELDS } from "./inbox.js";
import { accountsHostFor, exchangeGrantCode, ZohoOAuth } from "./oauth.js";

/** What the Self Client's code must be generated with (docs/cliq.md). */
export const CLIQ_SCOPES = "ZohoCliq.StorageData.ALL,ZohoCliq.Storage.CREATE,ZohoCliq.Storage.READ";

/**
 * Set keys in an env file in place, appending the ones it lacks. Every
 * other line — comments, keys this does not know — is kept as it was.
 */
export function setEnvValues(envPath: string, values: Record<string, string>): void {
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
  const pending = new Map(Object.entries(values));
  const updated = lines.map((line) => {
    const match = /^\s*#?\s*([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key && pending.has(key)) {
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });
  while (updated.length > 0 && updated[updated.length - 1] === "") {
    updated.pop();
  }
  for (const [key, value] of pending) {
    updated.push(`${key}=${value}`);
  }
  fs.writeFileSync(envPath, `${updated.join("\n")}\n`, { mode: 0o600 });
  // `mode` only applies to a new file; this one holds secrets either way.
  fs.chmodSync(envPath, 0o600);
}

/**
 * `squeak cliq-auth <client-id> <client-secret> <code>`: trade the Self
 * Client's one-time code for a refresh token, create the inbox database the
 * bot's handlers write to, and save the settings. Needs
 * SQUEAK_CLIQ_WEBHOOK_URL already set, which says which data centre to use.
 */
export async function runCliqAuth(
  envPath: string,
  env: Record<string, string>,
  args: string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const [clientId, clientSecret, code] = args;
  if (!clientId || !clientSecret || !code) {
    throw new Error("Usage: squeak cliq-auth <client-id> <client-secret> <code>  (see docs/cliq.md)");
  }
  const webhookUrl = env.SQUEAK_CLIQ_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error("Set SQUEAK_CLIQ_WEBHOOK_URL first: it says which Zoho data centre your Cliq is in.");
  }
  const cliqHost = parseCliqWebhookUrl(webhookUrl).hostname;
  const accountsHost = accountsHostFor(cliqHost);

  const refreshToken = await exchangeGrantCode({ accountsHost, clientId, clientSecret, code }, fetchImpl);
  const oauth = new ZohoOAuth({ accountsHost, clientId, clientSecret, refreshToken, fetch: fetchImpl });
  const database = await createInboxDatabase(cliqHost, await oauth.accessToken(), fetchImpl);

  setEnvValues(envPath, {
    SQUEAK_CLIQ_CLIENT_ID: clientId,
    SQUEAK_CLIQ_CLIENT_SECRET: clientSecret,
    SQUEAK_CLIQ_REFRESH_TOKEN: refreshToken,
  });
  return [
    `Saved the Zoho refresh token to ${envPath}.`,
    database,
    env.SQUEAK_CLIQ_OWNER_ID && env.SQUEAK_CLIQ_OWNER_EMAIL
      ? "Restart Squeak to turn on two-way Cliq."
      : "Set SQUEAK_CLIQ_OWNER_ID and SQUEAK_CLIQ_OWNER_EMAIL too (docs/cliq.md), then restart Squeak.",
  ];
}

async function createInboxDatabase(cliqHost: string, token: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(`https://${cliqHost}/api/v2/storages`, {
    method: "POST",
    headers: { authorization: `Zoho-oauthtoken ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: CLIQ_INBOX_DATABASE,
      display_name: "Squeak inbox",
      description: "What you do in Cliq, waiting for Squeak on the Mac to act on it.",
      fields: CLIQ_INBOX_FIELDS,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text().catch(() => "");
  if (response.ok) {
    return `Created the Cliq database "${CLIQ_INBOX_DATABASE}".`;
  }
  if (/exist|duplicate|already/i.test(text)) {
    return `The Cliq database "${CLIQ_INBOX_DATABASE}" already exists; left it as it is.`;
  }
  throw new Error(`Could not create the Cliq database (${response.status}): ${text.slice(0, 300)}`);
}
