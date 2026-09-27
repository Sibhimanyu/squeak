import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { accountsHostFor, exchangeGrantCode, ZohoOAuth } from "./oauth.js";
import { setEnvValues } from "./setup.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("accountsHostFor", () => {
  it("stays in Cliq's data centre", () => {
    expect(accountsHostFor("cliq.zoho.in")).toBe("accounts.zoho.in");
    expect(accountsHostFor("cliq.zoho.com.au")).toBe("accounts.zoho.com.au");
    expect(accountsHostFor("cliq.zohocloud.ca")).toBe("accounts.zohocloud.ca");
  });
});

describe("ZohoOAuth", () => {
  const options = { accountsHost: "accounts.zoho.in", clientId: "id", clientSecret: "secret", refreshToken: "rt" };

  it("mints one access token and reuses it until just before it expires", async () => {
    let clock = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: "a1", expires_in: 3600 }))
      .mockResolvedValueOnce(json({ access_token: "a2", expires_in: 3600 }));
    const oauth = new ZohoOAuth({ ...options, fetch: fetchMock, now: () => clock });

    const [first, second] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);
    expect([first, second]).toEqual(["a1", "a1"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://accounts.zoho.in/oauth/v2/token");
    expect(String(fetchMock.mock.calls[0]![1].body)).toContain("grant_type=refresh_token");

    clock = 3600_000 - 30_000;
    expect(await oauth.accessToken()).toBe("a2");
  });

  it("reports Zoho's 200-with-error as a failure", async () => {
    const oauth = new ZohoOAuth({ ...options, fetch: vi.fn().mockResolvedValue(json({ error: "invalid_code" })) });
    await expect(oauth.accessToken()).rejects.toThrow(/invalid_code/);
  });

  it("exchanges a grant code for a refresh token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ access_token: "a", refresh_token: "1000.r.t" }));
    expect(await exchangeGrantCode({ ...options, code: "c" }, fetchMock)).toBe("1000.r.t");
    expect(String(fetchMock.mock.calls[0]![1].body)).toContain("grant_type=authorization_code");
  });
});

describe("setEnvValues", () => {
  it("updates keys in place, uncomments a switched-off one, appends the rest, keeps everything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "squeak-env-"));
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "# comment\nSQUEAK_BOT_TOKEN=abc\n# SQUEAK_CLIQ_CLIENT_ID=old\nOTHER=1\n");

    setEnvValues(file, { SQUEAK_CLIQ_CLIENT_ID: "new", SQUEAK_CLIQ_REFRESH_TOKEN: "rt" });

    expect(fs.readFileSync(file, "utf8")).toBe(
      "# comment\nSQUEAK_BOT_TOKEN=abc\nSQUEAK_CLIQ_CLIENT_ID=new\nOTHER=1\nSQUEAK_CLIQ_REFRESH_TOKEN=rt\n",
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
