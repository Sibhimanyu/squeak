import http from "node:http";

/**
 * The daemon's port, bound before anything slow is loaded. Until the real ingress adopts the socket it answers
 * `/state` with a minimal valid empty state (`starting: true`, every field a client decodes), `/control/*` with
 * 503 `{ "error": "starting" }` and anything else with 503, so a restart reads as "starting", not "Trouble
 * connecting". Node built-ins only: it runs before the heavy modules are imported.
 */
const EARLY_STATE = {
  starting: true,
  conductorLinked: true,
  trackedCount: 0,
  duck: { mood: "asleep", blockedCount: 0, workingCount: 0, justFinished: [] },
  codexUsage: null,
  claudeLimits: null,
  active: [],
  others: [],
  attention: [],
};

let early: { port: number; server: http.Server } | null = null;

function answer(request: http.IncomingMessage, response: http.ServerResponse): void {
  request.resume();
  if (request.method === "GET" && request.url?.startsWith("/state")) {
    response.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify({ ...EARLY_STATE, generatedAt: new Date().toISOString() }));
    return;
  }
  response.writeHead(503, { "content-type": "application/json", "retry-after": "2" });
  response.end(JSON.stringify({ error: "starting" }));
}

/** Binds 127.0.0.1:port. Never throws: a busy port is left for the real ingress to report. */
export async function listenEarly(port: number): Promise<boolean> {
  if (early) return true;
  const server = http.createServer(answer);
  const ok = await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.once("listening", () => resolve(true));
    server.listen(port, "127.0.0.1");
  });
  if (!ok) return false;
  server.on("error", () => undefined);
  early = { port, server };
  return true;
}

/** Hands the bound server to the real ingress (null when none was bound for this port). */
export function takeEarlyServer(port: number): http.Server | null {
  if (!early || early.port !== port) return null;
  const { server } = early;
  early = null;
  server.removeAllListeners("request");
  return server;
}

/** Closes an unadopted early server (a failed start). */
export function dropEarlyServer(): void {
  early?.server.close();
  early = null;
}

const quit = (): void => process.exit(0);
let quitting = false;

/** Until the app owns shutdown, SIGTERM/SIGINT simply exit (nothing is running yet that needs saving). */
export function exitOnSignalsUntilReady(): void {
  if (quitting) return;
  quitting = true;
  process.on("SIGTERM", quit);
  process.on("SIGINT", quit);
}

export function appOwnsSignals(): void {
  process.off("SIGTERM", quit);
  process.off("SIGINT", quit);
  quitting = false;
}

/** Graceful stop on a signal, then a hard exit: whatever hangs in `stop` must not keep a restart waiting. */
export function shutdownOnSignals(
  stop: () => Promise<void>,
  hardExitMs = 5000,
  exit: (code: number) => void = (c) => process.exit(c),
): (signal: string) => void {
  let started = false;
  return (signal: string) => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => exit(0), hardExitMs);
    timer.unref?.();
    void stop().then(
      () => exit(0),
      () => exit(1),
    );
    void signal;
  };
}
