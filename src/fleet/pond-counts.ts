/**
 * The pond dashboard's four numbers, decided here so the Mac page and the phone's pond screen draw the same ones:
 * on duty, working (on-duty ducks mid-turn), needs you (every duck the one rule names, on duty or not: a failure in a
 * Duck that went Off duty still waits for you; `needs-you.ts`) and off duty, with the total. Surfaces only draw them; they compute locally just when a daemon sends no `counts`.
 */
export interface PondCounts {
  onDuty: number;
  working: number;
  needsYou: number;
  offDuty: number;
  total: number;
}

export interface DuckFlags {
  duty: "on" | "off";
  working: boolean;
  needsYou: boolean;
}

export function pondCounts(ducks: readonly DuckFlags[]): PondCounts {
  const on = ducks.filter((d) => d.duty !== "off");
  const needs = ducks.filter((d) => d.needsYou).length;
  // A duck that needs you is not also counted as working.
  const working = on.filter((d) => d.working && !d.needsYou).length;
  return { onDuty: on.length, working, needsYou: needs, offDuty: ducks.length - on.length, total: ducks.length };
}
