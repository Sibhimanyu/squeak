import { describe, expect, it, vi } from "vitest";

import { CliqWebhook, markdownToCliq, parseCliqWebhookUrl } from "./client.js";

const URL_OK = "https://cliq.zoho.com/api/v2/bots/squeak/message?zapikey=secret123";

function ok(): Response {
  return new Response(null, { status: 204 });
}

describe("parseCliqWebhookUrl", () => {
  it("accepts a Cliq incoming webhook in any data centre", () => {
    expect(parseCliqWebhookUrl(URL_OK).hostname).toBe("cliq.zoho.com");
    expect(parseCliqWebhookUrl("https://cliq.zoho.in/api/v2/channelsbyname/agents/message?zapikey=k").hostname).toBe(
      "cliq.zoho.in",
    );
  });

  it("refuses anything that would send session content somewhere else", () => {
    expect(() => parseCliqWebhookUrl("http://cliq.zoho.com/api/v2/bots/x/incoming?zapikey=k")).toThrow(/https/);
    expect(() => parseCliqWebhookUrl("https://cliq.zoho.com.evil.io/x?zapikey=k")).toThrow(/Zoho Cliq/);
    expect(() => parseCliqWebhookUrl("https://evil.example/cliq.zoho.com?zapikey=k")).toThrow(/Zoho Cliq/);
    expect(() => parseCliqWebhookUrl("https://cliq.zoho.com/api/v2/bots/x/incoming")).toThrow(/zapikey/);
    expect(() => parseCliqWebhookUrl("not a url")).toThrow(/not a URL/);
  });
});

describe("markdownToCliq", () => {
  it("turns double-star bold into Cliq's single star and leaves italics alone", () => {
    expect(markdownToCliq("🔴 **squeak · main** — needs approval\n_2 files changed_")).toBe(
      "🔴 *squeak · main* — needs approval\n_2 files changed_",
    );
  });
});

describe("CliqWebhook", () => {
  it("posts the converted text as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    await new CliqWebhook(URL_OK, { fetch: fetchMock }).post("**done**");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(URL_OK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ text: "*done*" });
  });

  it("splits long text rather than truncating it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    await new CliqWebhook(URL_OK, { fetch: fetchMock }).post(long);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).text as string).join("\n");
    expect(sent).toContain("line 0 ");
    expect(sent).toContain("line 299 ");
  });

  it("retries once on a 429 or 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(ok());
    await new CliqWebhook(URL_OK, { fetch: fetchMock, retryDelayMs: 0 }).post("hi");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx, and never puts the key in the error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
    const error = await new CliqWebhook(URL_OK, { fetch: fetchMock, retryDelayMs: 0 }).post("hi").catch((e) => e);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(error.message)).toContain("401");
    expect(String(error.message)).not.toContain("secret123");
  });

  it("keeps posting after one failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 400 }))
      .mockResolvedValueOnce(ok());
    const webhook = new CliqWebhook(URL_OK, { fetch: fetchMock, retryDelayMs: 0 });
    await expect(webhook.post("one")).rejects.toThrow();
    await expect(webhook.post("two")).resolves.toBeUndefined();
  });

  it("reports an unreachable host without the URL", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`fetch failed ${URL_OK}`));
    const error = await new CliqWebhook(URL_OK, { fetch: fetchMock, retryDelayMs: 0 }).post("hi").catch((e) => e);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(error.message)).not.toContain("secret123");
  });
});
