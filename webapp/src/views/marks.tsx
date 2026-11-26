// The small marks every Pond screen shares: avatars, the Pond tile, the waiting triangle and the working tide.

import { hueOf, initial } from "../format.js";

export const tint = (key: string): Record<string, string> => ({ "--h": String(hueOf(key)) });

export function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span class={`avatar person${small ? " small" : ""}`} style={tint(name)} aria-hidden="true">
      {initial(name)}
    </span>
  );
}

export function Tile({ pond }: { pond: { pondId: string; name: string } }) {
  return (
    <span class="avatar tile" style={tint(pond.pondId)} aria-hidden="true">
      {initial(pond.name)}
    </span>
  );
}

export function Warning() {
  return (
    <svg class="waiting" viewBox="0 0 24 24" width="22" height="22" role="img" aria-label="Waiting for you">
      <path
        d="M12 3.5 2.8 19.5h18.4L12 3.5Z M12 10v4.5 M12 17.2v.1"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** The working mark: a small pixel tide, still in the markup and animated only in CSS (and not at all under reduced motion). */
export function Working() {
  return <span class="tide" role="img" aria-label="Working" />;
}
