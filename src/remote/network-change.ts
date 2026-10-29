import os from "node:os";

/**
 * Says when this Mac's network changed (Wi-Fi to the iPhone's hotspot, a cable pulled, a VPN up): a held stream
 * to the relay does not notice, it just stops hearing anything, and waits out its stall timer (75 s) before
 * reconnecting. A phone that pings every 10 s sees a Mac that is "not answering" for all of that. Anyone holding a
 * stream subscribes here and drops it at once instead.
 *
 * A change is the set of non-internal IPv4 addresses and the interfaces that carry them. IPv6 is left out: its
 * temporary addresses rotate on their own and would reconnect everything for nothing.
 */

const POLL_MS = 2_000;

export function networkSignature(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string {
  const parts: string[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (!info.internal && info.family === "IPv4") parts.push(`${name}=${info.address}`);
    }
  }
  return parts.sort().join(",");
}

type Listener = () => void;

const listeners = new Set<Listener>();
let timer: NodeJS.Timeout | null = null;
let last = "";

/** Tells every subscriber now; the poll calls it, and a test can too. */
export function notifyNetworkChanged(): void {
  for (const listener of [...listeners]) listener();
}

/** Calls `listener` whenever the network changes, until the returned function is called. */
export function onNetworkChange(listener: Listener): () => void {
  listeners.add(listener);
  if (!timer) {
    last = networkSignature();
    timer = setInterval(() => {
      const now = networkSignature();
      if (now === last) return;
      last = now;
      notifyNetworkChanged();
    }, POLL_MS);
    timer.unref?.();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
