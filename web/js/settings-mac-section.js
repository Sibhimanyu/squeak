// Registers the Mac settings: sections on the Settings screen (Mac 20, Keep awake 30, Notifications 40,
// Hotspot failover 50, Phone calls 60) and the Mac controls page they link to. Imported by screens.js.

import { registerScreen } from "./router.js";
import { hasSettingsSection, registerSettingsSection } from "./settings-sections.js";
import { awakeSection, hotspotSection, macSection, notificationsSection, voiceSection } from "./settings-mac-parts.js";

if (!hasSettingsSection("mac")) {
  registerSettingsSection({ id: "mac", order: 20, title: "Your Mac", render: macSection });
  registerSettingsSection({ id: "awake", order: 30, title: "Keep awake", render: awakeSection });
  registerSettingsSection({ id: "notifications", order: 40, title: "Notifications", render: notificationsSection });
  registerSettingsSection({ id: "hotspot", order: 50, title: "Hotspot failover", render: hotspotSection });
  registerSettingsSection({ id: "voice", order: 60, title: "Phone calls", render: voiceSection });
  registerScreen({
    id: "mac-controls",
    title: "Mac controls",
    navPlacement: "none",
    load: () => import("./mac-controls-view.js"),
  });
}
