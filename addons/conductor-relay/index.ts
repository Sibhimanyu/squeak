import path from "node:path";
import type { Addon } from "../../src/addons.js";
import { CONDUCTOR_ROUTE_SERVICE, CONDUCTOR_SERVICE, type ConductorService } from "../conductor/route.js";
import { realEffects } from "./core.js";
import { ConductorRelayService } from "./service.js";
import { relayStatus, resetRelay, setupRelay } from "./setup.js";

/**
 * The Conductor relay add-on: Conductor's Remote Control host connects to Squeak on loopback and a reply goes into
 * a chat through Conductor's own composer. Not distributed; see README.md. It needs the Conductor add-on (loaded and
 * enabled at start): it reads Conductor's database path from it and gives it the route replies and new chats take
 * first (`CONDUCTOR_ROUTE_SERVICE`), plus the `/control/relay*` routes the Mac app's Settings page uses.
 */
const addon: Addon = {
  activate(context) {
    const conductor = context.services.get<ConductorService>(CONDUCTOR_SERVICE);
    if (!conductor) throw new Error("the Conductor add-on is not loaded");
    const conductorDbPath = conductor.dbPath;
    const statePath = path.join(context.supportDir, "conductor-relay.json");
    const service = new ConductorRelayService({ conductorDbPath, statePath });
    context.services.provide(CONDUCTOR_ROUTE_SERVICE, service);
    const options = () => ({
      effects: realEffects({ conductorDbPath, statePath }),
      live: { isReady: () => service.isReady(), lastHostAt: () => service.lastHostAt() },
    });
    const outcome = (result: { ok: boolean }) => ({ status: result.ok ? 200 : 409, body: result });
    return {
      routes: [
        { method: "GET", path: "/control/relay", handle: () => ({ status: 200, body: relayStatus(options()) }) },
        {
          method: "POST",
          path: "/control/relay/setup",
          handle: (body) => {
            const result = setupRelay(options(), { force: body.force === true });
            // The relay listens only once an override and a device exist; start it now rather than at the next start.
            if (result.ok) service.start();
            return outcome(result);
          },
        },
        { method: "POST", path: "/control/relay/reset", handle: () => outcome(resetRelay(options())) },
      ],
      // Listening starts once the daemon is up.
      start: () => service.start(),
      stop: () => service.stop(),
    };
  },
};

export default addon;
