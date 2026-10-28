// The screens of the page. One line per screen, each a side-effect import of a
// small registration file that calls `registerScreen` (router.js) and, when it
// has settings, `registerSettingsSection` (settings-sections.js). The screen's
// own code is loaded only when it is opened (`load: () => import(...)`), so a
// line here costs nothing until then. See docs/web-app.md, "Adding a screen".

import "./settings-screen.js";
import "./new-chat-screen.js";
import "./settings-mac-section.js";
import "./usage-screen.js";
import "./film-screen.js";
