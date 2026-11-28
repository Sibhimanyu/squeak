/**
 * The pond dashboard's four numbers, decided here so the Mac page and the phone's pond screen draw the same ones:
 * open, working (open ducks mid-turn), needs you (every duck the one rule names, open or not: a failure in a
 * Duck that closed still waits for you; `needs-you.ts`) and closed, with the total. Surfaces only draw them; they compute locally just when a daemon sends no `counts`.
 */
export interface PondCounts {
  open: number;
  working: number;
  needsYou: number;
  closed: number;
  total: number;
}

export interface DuckFlags {
  open: boolean;
  working: boolean;
  needsYou: boolean;
}

export function pondCounts(ducks: readonly DuckFlags[]): PondCounts {
  const on = ducks.filter((d) => d.open);
  const needs = ducks.filter((d) => d.needsYou).length;
  // A duck that needs you is not also counted as working.
  const working = on.filter((d) => d.working && !d.needsYou).length;
  return { open: on.length, working, needsYou: needs, closed: ducks.length - on.length, total: ducks.length };
}
