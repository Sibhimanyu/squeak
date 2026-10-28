import { settingsIcon } from "./icons.js";
import { registerScreen } from "./router.js";

registerScreen({
  id: "settings",
  title: "Settings",
  icon: settingsIcon,
  navPlacement: "tab",
  load: () => import("./settings-view.js"),
});
