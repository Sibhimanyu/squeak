// The few settings this browser keeps beside its keys (IndexedDB, so Forget
// wipes them): what is stored, and what each means when nothing is stored.

/** "Show thinking live" is on, as on the iPhone, unless the stored preference is an explicit false. */
export function verbosePref(prefs) {
  return prefs?.verbose !== false;
}

/** How Home groups the active chats; anything stored but "status" is by project. */
export function groupingPref(prefs) {
  return prefs?.grouping === "status" ? "status" : "projects";
}
