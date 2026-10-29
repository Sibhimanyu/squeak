import { chartIcon } from "./icons.js";
import { registerScreen } from "./router.js";

registerScreen({
  id: "usage",
  title: "Usage",
  icon: chartIcon,
  navPlacement: "tab",
  order: 40,
  load: () => import("./usage-view.js"),
});
