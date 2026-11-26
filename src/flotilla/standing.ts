/**
 * What a person's posts say once they are out of a Pond (docs/spec.md, "What stays when someone leaves or is removed"): their
 * posts stay, under their name marked "(left)"; when their Squeak account is gone they read "Former member". A person who
 * comes back (a new invite to the same account) is the same person again, with neither mark. One place, so the Owner's own
 * Room and a Member's read of it cannot say it two ways.
 */
export type Standing = "left" | "former";

export function shownName(name: string, standing: Standing | undefined): string {
  if (standing === "former") return "Former member";
  if (standing === "left") return `${name} (left)`;
  return name;
}

export const readStanding = (v: unknown): Standing | undefined => (v === "left" || v === "former" ? v : undefined);
