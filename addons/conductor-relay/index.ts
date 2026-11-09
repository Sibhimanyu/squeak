import path from "node:path";
import type { Addon } from "../../src/addons.js";
import { realEffects } from "./core.js";
import { ConductorRelayService } from "./service.js";
import { relayStatus, resetRelay, setupRelay } from "./setup.js";

/**
 * The Conductor relay add-on: Conductor's Remote Control host connects to Squeak on loopback and a reply goes into
 * a chat through Conductor's own composer. Not distributed; see README.md. Core reaches it only through
 * `Addon` (src/addons.ts): the route it offers `ConductorReplier`, and the `/control/relay*` routes the Mac app's
 * Settings › Conductor page uses.
 */
const addon: Addon = {
  activate(context) {
    const statePath = path.join(context.supportDir, "conductor-relay.json");
    const service = new ConductorRelayService({ conductorDbPath: context.conductorDbPath, statePath });
    const options = () => ({
      effects: realEffects({ conductorDbPath: context.conductorDbPath, statePath }),
      live: { isReady: () => service.isReady(), lastHostAt: () => service.lastHostAt() },
    });
    const outcome = (result: { ok: boolean }) => ({ status: result.ok ? 200 : 409, body: result });
    return {
      conductorRoute: service,
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
      stop: () => service.stop(),
    };
  },
};

export default addon;
