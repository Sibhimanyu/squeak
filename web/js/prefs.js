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

/** Whether the right panel (the inspector) is open on a wide screen: closed until the owner opens it (DESIGN.md §8.10), then as left. */
export function inspectorPref(prefs) {
  return prefs?.inspector === true;
}

/** Home's view: the board (default) or the Projects list. */
export function homeViewPref(prefs) {
  return prefs?.homeView === "projects" ? "projects" : "board";
}
