import path from "node:path";

import { defaultHookInstallPaths } from "../fleet/hook-install.js";
import { logger } from "../utils/logger.js";
import { SessionHost } from "./host.js";
import { DEFAULT_HOST_PORT, NativeServer } from "./server.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

/** `squeak host`: Squeak's own session host. `native.db` (not `squeak.db`, which the daemon's bridge already owns). */
export async function runHost(supportDir: string): Promise<void> {
  const store = new NativeStore(path.join(supportDir, "native.db"));
  // Late-bound: the server (and so the tools' address) exists only after the host.
  let server: NativeServer | null = null;
  const host = new SessionHost({ store, mcpFor: (id) => server?.mcpEndpoint(id) ?? null });
  const workspaces = new WorkspaceManager({ store });
  workspaces.recover();
  host.start();
  const port = Number.parseInt(process.env.SQUEAK_HOST_PORT ?? "", 10) || DEFAULT_HOST_PORT;
  server = new NativeServer({
    host,
    store,
    workspaces,
    tokenPath: defaultHookInstallPaths(supportDir).tokenPath,
    port,
  });
  await server.start();
  logger.info("squeak host listening", { port });
  const shutdown = (): void => {
    void (async () => {
      await server.stop();
      await workspaces.shutdown();
      await host.stop();
      store.close();
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
