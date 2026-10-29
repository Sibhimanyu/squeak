import { registerScreen } from "./router.js";

// A film's own screen: reachable with `openFilm(ctx.navigate, id)` from Home's Films card and Needs you.
registerScreen({
  id: "film",
  title: "Film",
  icon: null,
  navPlacement: "none",
  load: () => import("./film-view.js"),
});
