import { plusIcon } from "./icons.js";
import { registerScreen } from "./router.js";

registerScreen({
  id: "new-chat",
  title: "New chat",
  icon: plusIcon,
  navPlacement: "action",
  order: 30,
  load: () => import("./new-chat-view.js"),
});
