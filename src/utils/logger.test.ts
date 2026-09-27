import { describe, expect, it, vi } from "vitest";

import { logger } from "./logger.js";

describe("logger", () => {
  it("redacts sensitive values from log metadata", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logger.error("test", {
      token: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      env: "TELEGRAM_BOT_TOKEN=123456789:abcdefghijklmnopqrstuvwxyzABCDE",
      path: "/Users/xudong/project/file.txt",
      cliq: "https://cliq.zoho.com/api/v2/bots/squeak/incoming?zapikey=1001.abc.def&x=1",
      zoho: "refresh 1000.0123456789abcdef0123.fedcba9876543210fedc failed",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("ERROR"),
      "test",
      expect.objectContaining({
        token: "[REDACTED_TELEGRAM_BOT_TOKEN]",
        env: "TELEGRAM_BOT_TOKEN=[REDACTED]",
        path: "/Users/[REDACTED]/project/file.txt",
        cliq: "https://cliq.zoho.com/api/v2/bots/squeak/incoming?zapikey=[REDACTED]&x=1",
        zoho: "refresh [REDACTED_ZOHO_TOKEN] failed",
      }),
    );

    spy.mockRestore();
  });
});
