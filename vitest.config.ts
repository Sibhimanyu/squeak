import { configDefaults, defineConfig } from "vitest/config";

// `VITEST_MAX_WORKERS=4 ./scripts/ship.sh` on a busy Mac: the voice-worker and git tests have 5 s timeouts and pass
// alone, but time out when every core is shared with the whole suite and other machines' work.
const maxWorkers = Number(process.env.VITEST_MAX_WORKERS) || undefined;

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.context/**", "macos/build/**", "**/.build/**"],
    // Git-backed tests spawn real git; with several builds running on this Mac they ran past the 5 s default
    // (every one passed alone). A slow test still fails, just not at 5 s.
    testTimeout: 20_000,
    ...(maxWorkers ? { maxWorkers } : {}),
  },
});
