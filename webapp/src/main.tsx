import { render } from "preact";
import { App } from "./app.js";
import { createAuth } from "./auth/auth.js";
import { prepareAddress } from "./boot.js";
import { loadConfig } from "./config.js";
import { createRelay } from "./relay/client.js";
import { createRouter } from "./router.js";

const config = loadConfig();
const storage = window.sessionStorage;
prepareAddress(window, storage);

const relay = createRelay(config.relayBase);
const auth = createAuth({ config, relay, storage, navigate: (url) => window.location.assign(url) });
const router = createRouter(window);

render(<App auth={auth} relay={relay} router={router} liveBase={config.liveBase} />, document.getElementById("app")!);
