import { runGateway } from "./gateway-main.js";

/** The Home Assistant add-on's entry point: only the gateway, bundled alone (scripts/build-voice-addon.sh). */
process.exitCode = await runGateway();
process.exit(process.exitCode);
