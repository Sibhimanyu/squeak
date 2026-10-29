// Home's Films card (FilmsCard and FilmRow in FilmViews.swift): every film the Mac lists, newest first, each
// with its poster, title, the call it is on and where its director is. A film waiting on you wears the one red
// edge. Four show; the rest open in place. Only drawn when the Mac publishes films (view.films is a list, which
// it sends only to a client whose caps say "films"). Text from the director goes in as text.

import { h } from "./dom.js";
import { chevronDown, chevronUp } from "./icons.js";
import { ago } from "./format.js";
import { filmState, openFilm } from "./film-state.js";
import { picture } from "./film-pictures.js";
import { filmLine, filmsSummary, readFilms, stateTone, stateWord, visibleFilms, waitingOnYou } from "./films-logic.js";

/** The state as a dot and a word: the words carry it, the colour only echoes it. */
export function stateMark(film, { pulse = false } = {}) {
  const tone = stateTone(film);
  const running = film.director.state === "running" && !waitingOnYou(film);
  return h(
    "span",
    { class: "fstate" },
    h("span", {
      class: `dot d-${tone === "needsYou" ? "needs" : tone}${pulse && running ? " pulse" : ""}`,
      "aria-hidden": "true",
    }),
    h("span", { class: waitingOnYou(film) ? "fstate-word loud" : "fstate-word" }, stateWord(film)),
  );
}

function filmRow(ctx, film) {
  const line = filmLine(film);
  const owner = { filmId: film.id };
  return h(
    "button",
    {
      class: "frow",
      type: "button",
      "data-film": film.id,
      "aria-label": `Film ${film.title}, ${stateWord(film)}${line ? `, ${line}` : ""}`,
      onclick: () => openFilm(ctx.navigate, film.id),
    },
    film.poster
      ? picture(ctx, owner, film.poster, { name: `Poster of ${film.title}`, cls: "fpic poster" })
      : h("span", { class: "fpic poster fpic-empty", "aria-hidden": "true" }, "▶"),
    h(
      "span",
      { class: "frow-body" },
      h(
        "span",
        { class: "frow-top" },
        h("span", { class: "frow-title" }, film.title),
        h("span", { class: "frow-age" }, ago(film.updatedAt)),
      ),
      line ? h("span", { class: "frow-line" }, line) : null,
      stateMark(film, { pulse: true }),
    ),
  );
}

/**
 * The card, or null when the Mac publishes no films. `ctx` is the screen context (`view`, `navigate`, `touch`);
 * null or a context without them draws nothing, so a Home that has no context yet is unharmed.
 */
export function renderFilmsCard(ctx) {
  const films = ctx?.view ? readFilms(ctx.view) : null;
  if (!films || films.length === 0 || typeof ctx.navigate !== "function") return null;
  const waiting = films.filter(waitingOnYou).length;
  const rows = visibleFilms(films, filmState.all);
  return h(
    "section",
    { class: waiting > 0 ? "gcard needs films" : "gcard films", "aria-label": "Films" },
    h(
      "div",
      { class: "ghead static" },
      h(
        "span",
        { class: "gtext" },
        h("span", { class: "gname" }, "Films"),
        h("span", { class: "gsub" }, filmsSummary(waiting, films.length)),
      ),
    ),
    rows.map((f) => filmRow(ctx, f)),
    films.length > rows.length || filmState.all
      ? films.length > 4
        ? h(
            "button",
            {
              class: "gfoot",
              type: "button",
              "aria-expanded": filmState.all ? "true" : "false",
              onclick: () => {
                filmState.all = !filmState.all;
                ctx.touch?.();
              },
            },
            h("span", null, filmState.all ? "Show fewer" : `Show all ${films.length} films`),
            filmState.all ? chevronUp() : chevronDown(),
          )
        : null
      : null,
  );
}
