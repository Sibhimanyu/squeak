// What the films screens remember between draws. The page rebuilds its DOM on every draw, so a draft, a
// selection or an open disclosure lives here and the nodes are made again from it. Kept apart from the views so
// the Home card (loaded with Home) and the film screen (loaded when opened) share it without loading each other.

export const filmState = {
  /** The film the film screen shows. */
  id: null,
  /** Home's Films card shows every film, not four. */
  all: false,
};

/** Opens a film's own screen. */
export function openFilm(navigate, id) {
  filmState.id = id;
  navigate("film");
}

/** For tests. */
export function resetFilmState() {
  filmState.id = null;
  filmState.all = false;
}
