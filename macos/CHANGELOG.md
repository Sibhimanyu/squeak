# Changelog

## 2.12.27

- Restart to update: if macOS blocks the in-place install, Squeak now reopens itself within seconds instead of staying closed.
- A blocked update says so plainly and offers Download update, Open App Management settings and Try again. Squeak remembers a Mac that blocks self-updates and leads with Download update next time.
- A slow or background download is no longer reported as stalled while it is still receiving data.
- The update log (~/Library/Logs/Squeak Mac/updates.log) now records the installer's own error.
- Closing the Squeak window right after opening it from the menu-bar popup no longer brings it back.
- Opening Squeak from Finder, Spotlight or its app icon now puts Squeak's menus in the menu bar instead of leaving Finder's.

## 2.12.26

- Check for updates now always answers: from the menu-bar popup, Settings or the app menu it opens the update window on what is happening (checking, an update ready to restart into, up to date, or a problem), instead of doing nothing when an update is already waiting.

## 2.12.25

- Phone calls: the add-on now remembers the Mac's recordings of the call prompts across restarts, so the first call after an update starts talking at once (needs Squeak Voice add-on 0.11.4: update it once in Home Assistant).

## 2.12.24

- Updates are rebuilt to be reliable. The menu-bar popup and Settings show the update live: downloading with a percentage, preparing, ready, restarting.
- Pressing Install or Check while an update is already downloading now joins it and shows its progress instead of doing nothing.
- A stuck check, download or install now ends after a short time with a clear message, Try again and Download manually.
- Restart to update is more reliable: Squeak reopens itself, and tells you if the update didn't install.
- Updates keep a log at ~/Library/Logs/Squeak Mac/updates.log, included in Copy diagnostics.

## 2.12.23

- The Conductor and Claude marks in the sidebars are drawn a little larger.

## 2.12.22

- Phone calls: "Update add-on" now really updates the Home Assistant add-on (Home Assistant does not let an add-on update itself, so Squeak now asks Home Assistant to do it), never spins forever, and says plainly when Home Assistant has not seen the new version yet, with a Check again button. Needs add-on 0.11.3: update it once in Home Assistant (Settings › Add-ons › Squeak Voice) to get the new permission.

## 2.12.21

- Calling Squeak: a recording now ends when you stop talking (or press hash), is capped at one minute, and if nothing is heard it says so instead of recording two minutes of silence. A message that is unclear or silent is never sent without a key press.
- Calling Squeak: the call starts with the chat you used last ("Press 1 for ..., the last one you used"), then the usual menus on 2.
- Calls break up less: nothing is made mid-call any more, every clip is padded so the line never runs dry, and the realistic voice is cached sentence by sentence and kept warm, so calls start talking sooner (needs Squeak Voice add-on 0.11.2).
- Test call shows "Line quality: good / fair / poor" and the call log records jitter, loss and delay.
- When an agent's question call hits a busy line (you are already on a call), Squeak rings when it ends instead of dropping it. A missed call is retried once after two minutes, and the question goes to Telegram if it hasn't already.
- Calls speak a shorter question and terse options ("The full text is on your phone"), and each call leaves a one-line summary in the call log; a message you send by phone gets a short text confirmation.

## 2.12.20

- Larger session rows, project titles and sidebar icons make sessions easier to read and select.

## 2.12.19

- Settings › Voice: "Set up realistic voice" installs the realistic call voice from the app, with live progress, a clear failure reason and Retry. It keeps going if you close Settings.
- A new "Phone calls setup" list at the top of Voice shows each step (Home Assistant add-on, add-on up to date, extension, PIN, realistic voice, test call) with its own button and a "Phone calls are ready" / "N steps left" summary.
- If Python 3.10 or newer is missing, the app says to run `brew install python`; a lost connection or low disk space gets its own plain message, and a download resumes on retry.

## 2.12.18

- Phone calls: Check for updates now also makes Home Assistant refresh its own add-on list, and Update add-on refreshes it first, so a newly published add-on version is seen straight away (needs Squeak Voice 0.11.1).

## 2.12.17

- Phone calls: Settings now shows when a newer Squeak Voice add-on is available and offers the Update add-on button (the daemon behind it was not sending the version, so a new add-on never showed up).

## 2.12.16

- Calling Squeak: after your message is read back, press 1 to send it and hang up, 2 to ask it as a question and hear the answer, 3 to record again.
- Calling Squeak: choose a chat, then press 3 to hear where it stands: its state, what it is doing now or its last message, what changed on disk, background work and when it last did anything. Questions and status are read-only: nothing is sent to the chat. Up to 3 answers per call.
- Squeak rings your phone immediately when an agent waits on you, and the natural voice follows while it rings, so the line is never silent when you answer (needs Squeak Voice add-on 0.11.0).
- New chat presets (names, models, thinking, workers) are now one shared setting: edit them on the Mac, iPhone or web and all three agree.
- Set up Telegram and Zoho Cliq from your iPhone or the web (token, linked chats, webhook, owner); the iPhone asks for Face ID first.
- The Conductor, Claude and Codex icons now appear throughout the Mac app, like on the iPhone.
- Phone calls: a Test call button in Settings, and the iPhone and web can play the voice sample, pick the realistic voice, set quick workspaces and read the call log.

## 2.12.15

- Removing Squeak: if you drag Squeak to the Trash, its background service now notices and cleans up after itself (hands Conductor back, stops, removes its hooks) and keeps your settings. The download also has an Uninstall Squeak item.

## 2.12.14

- Phone calls: Settings now always shows whether the Home Assistant add-on is up to date, with a Check for updates button, and an Update add-on button when a newer version exists. Squeak looks up the newest version itself, so a new version shows up straight away.

## 2.12.13

- Phone calls: a Test call button in Settings › Phone calls rings you with a made-up question and shows how it went, like on the iPhone.
- Your iPhone and the web app can now do everything the Mac settings do for calls: play the voice sample, switch the realistic voice and pick it, set quick workspaces and read the call log (the web also got Pause calls and the full PIN controls).

## 2.12.12

- Calling Squeak: every step now says "Press star to hear this again", and star repeats it, including what it heard from you.
- Calling Squeak: it asks which workspace first even before you set favourites (workspaces are numbered by recent activity); favourites in Settings › Phone calls › Quick workspaces keep their own numbers.
- Calling Squeak: names are spoken short and whole ("squeak, ushuaia") instead of a cut-off branch name; the wording is more like a phone line ("Hello, this is Squeak", "Done. Your message was sent to …").
- Calling Squeak: the pause after you finish speaking is much shorter, and the line no longer goes silent between prompts, which was a cause of the voice breaking up (add-on 0.9.5).
- The Calls log marks any line the add-on had to speak in its own voice, and always shows the line quality.

## 2.12.11

- Quitting Squeak now stays quit: when an update was waiting to install, a quit you chose no longer reopened the app.
- Phone calls: the add-on's panel links to its updates in Home Assistant.

## 2.12.10

- Calling Squeak: it now asks which workspace first. Set favourite workspaces with a number each in Settings › Phone calls › Quick workspaces; press the number (even before it finishes reading) to pick the workspace, then the chat.
- Calling Squeak: the first word of your message is no longer cut off ("Telegram" was heard as "egram"), and names like Telegram and Conductor are recognised more reliably.
- Calling Squeak: every prompt and the read-back are now played in the realistic voice made on this Mac, so the line no longer breaks up (add-on 0.9.4).
- Phone calls: the Calls page shows a detailed, expandable log for each call, with timestamps: what Squeak said, what it heard, the keys pressed and each step. Calls you make to Squeak are listed too.

## 2.12.9

- Phone calls: a realistic voice made on this Mac. Run `squeak voice-tts-setup` once, then Settings › Phone calls › Voice turns it on and picks the voice; the Home Assistant add-on (0.9.3) plays it in the call instead of its plainer one. If it fails, the plain voice speaks and the call still goes.
- Phone calls: changing the PIN or when it is asked no longer gets overwritten by a refresh that was already in flight.

## 2.12.8

- Phone calls: after you approve a gateway, Squeak shows "Connecting to the add-on…" with a progress indicator until the add-on reports in, instead of looking unchanged for a while.

## 2.12.7

- After Squeak updates itself, its Dock icon shows up properly instead of sometimes appearing as a speck.

## 2.12.6

- Phone calls: add a Home Assistant gateway by typing the short code its panel shows; no keys or addresses to copy.
- Phone calls: pause calls for an hour, four hours, until tomorrow morning, or until you turn them back on.
- The Dock icon stays up while a window is opening, and no longer lingers after the last window closes.
- Settings has a cleaner layout, with clearer Telegram, Zoho Cliq and update rows, and the Uninstall dialog fits the window.

## 2.12.5

- Codex chats are found even when their folders have been pruned by modification time, so they no longer stay stuck on “Starting…”.
- Edit the built-in new-chat presets in Settings and use the updated choices wherever you start a chat.
- A redesigned Mac installer makes it clearer how to drag Squeak into Applications.

## 2.12.4

- Pair a phone: a larger, sharper QR code with clear app and web instructions, layouts for smaller windows, and a copy button that matches your choice.
- The collapsed sidebar stays narrow when switching between chats, projects, and Settings.
- Phone calls: see call history and the voice add-on log, and choose when calls to you and calls you make ask for your calling PIN. Requires Squeak Voice 0.8.0 for the PIN choices.

## 2.12.3

- Pair a phone: choose iPhone app or Web, and the QR code and Copy button match: the app code opens Squeak for iPhone, the web code opens Squeak for Web.

## 2.12.2

- Updates: after "Restart to update" Squeak always comes back. When Sparkle's own relaunch doesn't happen, a small watcher reopens the app once the new version is installed (or after a minute and a half if the install failed).

## 2.12.1

- Settings › About › Uninstall Squeak…: shows exactly what will be removed, hands Conductor back first, then removes Squeak's service, hooks, admin rules, Keychain items and files, and moves the app to the Trash. Also available as `squeak uninstall` (docs/uninstall.md).

## 2.12.0

- A new first run: Welcome, Connect (the service, hooks into the agents it finds, and Conductor, in one step), a
  first win with your own session, then where Squeak should reach you away from the Mac: the iPhone app, the web
  version on any phone (scan a code, add it to your home screen), Telegram (guided through BotFather), or later.
  Each phase has its own animated scene. It asks macOS for nothing but notifications.
- Permissions are asked only when you turn on what needs them, with a screen that says what it's for and which app
  to find, and ticks by itself once granted. Squeak Hands is now bundled and kept up to date by the app.
- After setup, one tip at a time in the menu-bar panel offers the next useful thing (keep awake after pairing, the
  shortcut, fewer notifications after a busy day). It needs the background service updated to this version.

## 2.11.11

- Refined setup and onboarding: the first-run walkthrough, Setup checklist and channel settings read more clearly.
- Menu-bar popup, sidebar and quick composer polish.

## 2.11.10

- Set up the iPhone channel from your Mac with your own Firebase project (automatically or by hand), or choose Squeak's limited shared server.
- Replace the setup checklist with a guided walkthrough that tracks progress, lets you skip optional steps, and shows what remains.
- Refine the floating duck, menu-bar controls, chat setup, and window layout.

## 2.11.9

- A clearer Mac setup with a menu-bar preview, progress through essential steps, and optional extras tucked away until needed.
- A first-session walkthrough shows how to start an agent session, find it under the duck, and know when it needs an answer.
- Empty session lists offer a fresh-session reminder, Check again, and a direct way back to Setup.

## 2.11.8

- A redesigned Squeak update window with clearer release notes, progress and update actions in light and dark appearances.
- Collapse and expand the sidebar reliably with ⌘B, ⌘\ or the sidebar button, in both chats and Settings.
- Refined default Glass appearance: 7% transparency and 68% sidebar contrast.

## 2.11.7

- Photos you attach are sent as Conductor's own image, so Conductor shows them inline.
- Settings > Phone calls > Pin: change the calling PIN, turn it off or on, or reset a forgotten one with Touch ID or your password.

## 2.11.6

- Adjust Glass transparency and sidebar contrast independently in Settings, General; Reduce Transparency still forces the solid canvas.
- Fix the collapsed sidebar so the native macOS column and its material shrink to the icon rail.
- Replace Sparkle’s standard update dialogs with a Squeak update window for permission, progress, install choices and errors.

## 2.11.5

- Collapse the shared sidebar to an icon rail from either Sessions or Settings, with aligned navigation, headers, and scrolling in the shared window shell.
- Choose Glass or Solid for the main window; Reduce Transparency always uses the solid canvas.
- Switch between Chat and Activity from a compact control beside Open in Conductor.
- Refresh the daemon's energy mode during its periodic power check so `/state` reflects changes made in macOS Settings.

## 2.11.4

- Animate the selected menu-bar tab between Home, Needs you, Usage, and Controls; respect Reduce Motion.

## 2.11.3

- Show a draggable floating duck that follows you between Spaces, reflects Squeak’s current state, and opens the session menu. Toggle it in Settings or with Control-Option-H.
- Refresh Settings with clearer section navigation, grouped content, and more consistent forms; improve sidebar search and navigation.

## 2.11.2

- Redesigned Settings with a cleaner, consistent background and clearer connection status, channels, and service details.

## 2.11.1

- Refined the menu-bar popover: clearer session rows, readable answer choices, and a compact menu that no longer shifts the content.
- Fixed the settings background so the desktop no longer shows through the page.
## 2.11.0

- Phone calls: Settings, Phone calls sets the extension Squeak rings when an agent is waiting on you (your phone
  app's extension in 3CX). Only an extension is accepted, never an outside number. Calls are placed by the
  Home Assistant add-on or by this Mac; it needs the background service updated to this version.

## 2.10.0

- A first-run Setup checklist: Squeak installs its background service (after one click), installs the agent
  hooks, connects Conductor, and walks you through notifications and the quick-message shortcut, with the next
  step highlighted. It is on Welcome, in Settings, Setup, and under "Finish setting up…" in the menu-bar popup
  until the required steps are done. Agent hooks can be installed and removed from here (it needs the
  background service updated to this version).

## 2.9.0

- Set up Conductor without the terminal: Settings, Conductor shows whether live replies and new chats from your
  phone are connected, and sets them up for you (it backs up Conductor's database first). After setting up,
  quit and reopen Conductor once. Welcome has an optional "Connect Conductor" step too.
- When a new chat fails because Conductor isn't connected, the New chat window offers "Open Conductor
  settings". It needs the background service updated to this version.

## 2.8.4

- Paste images (⌘V), drop image files or press + in the chat composer, New chat, the popup and the quick
  message: the picture is saved in the chat's folder and the message tells the agent where.
- Queued messages show under the chat, and Steer sends one into the running turn now; Edit and Delete work
  too. It needs the background service updated to this version.
- Pressing a project on Home opens it, with its chats grouped by status.
- The Connected row in the sidebar opens the connection details; the awake and power chips on Home open Settings.
- The popup's rows, tabs and buttons line up on one even margin.

## 2.8.3

- A picture an agent puts on the line right after a label ("At rest:") now shows as a picture instead of `[image: …]`.

## 2.8.2

- The sidebar is redone: a glass look that lets the desktop show through, the duck and the Squeak name with the
  new-chat button on one row, a roomier search field and larger menu items.

## 2.8.1

- The whole app is back to standard macOS sizes: smaller type, tighter rows and a 360 pt menu-bar popup,
  where 2.8.0 looked zoomed in. New chat is a 580 pt window.
- Dark mode uses Conductor's warm greys instead of near-black.
- The empty grey bar across the top of the conversation window is gone.

## 2.8.0

- Squeak for Mac is redesigned to match the iPhone app: the conversation window opens on Home (projects, a Mac
  status strip) with Needs you as its own page, where each blocked chat has one-tap lettered answers and a
  reply field.
- New chat has the iPhone's presets (Best, Balanced, Save usage) and a Customize section: model, thinking
  level, Split the work (the chat plans, cheaper models write the code and run tests) and Plan first.
  Older background services ignore the split, so update the service to use it.
- The menu-bar popup is now a control surface: Home, Needs you, Usage and Controls tabs, New chat and a chat's
  conversation inside the popup, Keep awake and notification switches without opening the window.
- Settings opens on Mac and Notifications, and Usage refreshes when you open it.

## 2.7.1

- The menu-bar panel no longer shows a lighter square patch behind its rounded bottom corners.

## 2.7.0

- Squeak checks for updates every hour, and tells you: a small dot on the menu-bar icon and one notification
  per new version. Settings, About has a switch for it.
- The update window and the update banner show what changed in each version, instead of a web page.

## 2.6.0

- Set Squeak's logo as your Telegram bot's picture with one button in Settings, Telegram. For Cliq, Settings
  saves the logo file and shows where to upload it, since Zoho does not allow setting it from Squeak.
- Clicking Squeak in the Dock, Finder or Spotlight now opens the conversation window instead of the small
  message panel. A clicked notification still opens the message panel for its chat.

## 2.5.0

- Choose what Telegram and Zoho Cliq tell you, in Settings: approvals, questions, "seems stuck", quota alerts,
  which finishes (Conductor chats, all agents or none), quiet hours, and a mute switch for each channel.
  It needs the background service updated to this version.

## 2.4.0

- See what each subagent is doing: tap a subagent in a chat's background strip to open its live steps, right
  in the conversation window. It needs the background service updated to this version.

## 2.3.0

- Updating is smoother: a banner says when an update is available or ready, "Restart to update" quits and
  relaunches Squeak, and it reopens the window, chat and Settings page you had open with an "Updated to" note.
- Updates can install automatically (Settings, About), including when you quit.
- Squeak's background service now comes with the app. Install it once from Settings, About, Background
  service; later app updates update it too, and it rolls back by itself if the new one does not start.
- A background service you run from a source checkout is never touched.

## 2.2.0

- Scrolling up in a chat loads earlier messages as you go, so long chats open fast and still reach all the
  way back.
- A message you sent no longer sticks to the end of a finished chat once its answer has arrived.
- Each message can show "Read by" and "Turn ended" receipts, so you can see that the agent picked it up
  and when its turn finished.
- Answering from your laptop keeps Squeak in sync: what you type in Conductor or the terminal shows up in
  the chat right away.
- A chat opens at its newest message more reliably.

## 2.1.34

- A Conductor chat's model line, under its title, is now a menu: switch to another model from the same
  provider, change the thinking level, or turn fast mode on. Conductor's own window shows the change.
- A working chat shows its subagents and background shells above the composer, each with how long it
  has run and how it ended, and says "Seems stuck" with a Stop button when the model has gone quiet.
- The … button beside Open in Conductor opens a pull request or archives the chat's workspace, and
  New chat can make a new workspace in any of your repositories.

## 2.1.33

- Squeak for iPhone's Mac controls show your apps with their real icons, and the controls for whichever
  app is in front: Conductor's workspaces and chats, or a browser's tabs. Squeak's app helper now
  draws those icons.

## 2.1.32

- In a chat, scrolling up shows a round button above the composer that takes you back to the newest
  message in one click (or ⌘↓). It says "New" when a message arrived while you were reading.

## 2.1.31

- Settings, Keep awake has two modes, Lid open and Lid closed, each with its own switches that it
  remembers. Lid open can keep the screen on (so the Mac doesn't lock), mute, use Low Power Mode and
  pause chat apps for the whole session; Lid closed keeps its own set for when the lid shuts. A
  lid-closed session goes back to the lid-open switches when you open the lid.

## 2.1.30

- Squeak for iPhone's Mac controls can set your Mac's energy mode: Automatic, Low Power or High Power.
  Low Power still turns on by itself when the Mac runs hot or the battery is low.

## 2.1.29

- Squeak for iPhone's Mac controls can now bring apps to the front, open and quit them, switch desktops,
  play, pause and skip music, and lock your Mac. Squeak carries a small helper for the app list.

## 2.1.28

- Fan control now offers fixed speeds too (40%, 60%, 80%, full), which you can pick from the Mac controls
  page in Squeak for iPhone, along with your Mac's volume, mute, brightness and screen off.

## 2.1.27

- Settings, Keep awake has a Heat section: your Mac's chip and battery temperature and fan speed
  during a session. When it warms up, Squeak turns on Low Power Mode and moves your agents to the
  efficiency cores so they keep going but cooler, and lets the Mac sleep if it stays hot.
- Set up fan control (one Mac password) lets Squeak run the fans at full speed while a session runs
  warm, and hand them back to macOS when it cools.

## 2.1.26

- Search results list the newest chats first.

## 2.1.25

- Quick message opens with a double-tap of Control. Settings, General offers Double-tap Control,
  Double-tap Option, ⌃⇧ Space, ⌥ Space or None. Double-tap needs Input Monitoring once (Squeak only
  notices the modifier taps, never what you type); until it is allowed, ⌃⇧ Space works.
- Squeak is now signed with a stable certificate, so permissions you grant stay across updates.

## 2.1.24

- Quick message no longer says a chat can't be answered when Squeak's service is only restarting.
  It says it is reconnecting, keeps Send on, and checks again when you press it; your text stays
  if it still can't go.

## 2.1.23

- A finished chat stays in the list for a day, not 15 minutes, so work you have not looked at yet
  does not vanish.

## 2.1.22

- Tables in an agent's message lay out properly: each row is as tall as its longest cell, cells
  never overlap, and a wide table scrolls sideways instead of being cut off.

## 2.1.21

- Hotspot failover can be set up on the Mac: Settings, Keep awake, type your iPhone's hotspot
  name and password, Save. The password stays in your Mac's Keychain.
- The safety rules show your Mac's real battery levels, not fixed 40% and 10%.

## 2.1.20

- Keep awake has its own page in Settings: what is on and until when, the one-time lid-closed
  setup in one button, what happens when the lid closes (display, sound, Low Power Mode, chat
  apps), the battery and heat safety rules in plain words, and hotspot failover.
- The menu-bar panel always shows Keep Mac awake: time left, the lid state, and Add 1 hour,
  Add lid closed and End as buttons instead of hidden menus.

## 2.1.19

- A chat whose reply ends with a question ("Want me to open a PR?") now counts as needing you:
  it moves to Needs you, shows the question, and raises the same banner as an agent waiting on
  an answer. Click the banner to answer in Quick message.

## 2.1.18

- The menu-bar panel no longer sits inside a taller, square-edged window after a section folds:
  the window shrinks to the panel, and its shadow is redrawn to match.

## 2.1.17

- Quick message: when Send is off because Squeak has no way to reply to the chat it is aimed at
  (a chat that is not Conductor's, or a Claude or Codex it cannot type into), it now says so and
  points to the To menu, instead of leaving a greyed button.

## 2.1.16

- Keep Mac awake: the menu lists the lid-closed choices first, so a Mac you set to stay
  awake stays awake with its lid shut. Lid open, and until you end it, are still there.

## 2.1.15

- Two new shortcuts for Quick message, easy to reach with one hand: ⌃⇧ Space and
  ⌃⇧ K. Choose one in Settings.
- ⌘\ shows or hides the sidebar from anywhere in the window, even while typing.
- The session list now says "10 sessions · 3 working" instead of "10 active
  across your Mac", which also counted finished and errored chats.

## 2.1.14

- Settings now opens inside the main window, System Settings style: a sidebar of
  pages (General, Connections, Telegram, Zoho Cliq, iPhone, Privacy, About)
  and one page at a time. Esc or Back to sessions returns to your chats.

## 2.1.13

- Squeak for Web moved to its own address, squeak-mac.web.app.

## 2.1.12

- Pairing now has a Copy pairing code button, for Squeak for Web
  (squeak-mac.web.app): paste the code there, then approve here.

## 2.1.11

- A redesigned menu-bar panel: chats are grouped into Needs you, Errors,
  Finished, Working and Idle (Idle folded away), each row shows its state, age,
  repo and agent, and a finished chat shows the start of its reply. New chat
  sits in the header; Settings, Check for Updates and Quit are under "…".
- Rows stay in place while the pointer is over the list, and Escape closes the panel.
- Clicking a notification shows the reply that notification was about, even
  if the chat has moved on since. If that reply can't be found, it says so
  instead of showing a different one.
- A reply only counts as read once you have actually seen it.

## 2.1.10

- Quitting Squeak from the Dock, or with ⌘Tab then Q, while its window is open
  now closes the window like ⌘Q does, and Squeak keeps running in the menu
  bar. "Quit Squeak" in the menu-bar panel, ⌥⌘Q, and logging out or shutting
  down still quit it completely.

## 2.1.9

- Clicking a notification opens the quick message on exactly that chat, also
  when Squeak was not running: the click is kept until the app is ready
  instead of being dropped at launch.
- Opening Squeak from Spotlight or Finder, or the activation a clicked
  notification causes, shows the quick message instead of the conversation
  window, and Squeak no longer opens a window by itself at launch.
- ⌥ Space is the default quick message shortcut. Anyone still on the old
  ⌥⌘M default is moved to it once; it stays selectable in Settings.
- Notifications have no inline reply. Clicking one, or dismissing it, never
  sends anything; unsent text stays as a draft per chat.

## 2.1.8

- ⌘Q in Squeak's window now closes the window and keeps Squeak in the menu
  bar. "Quit Squeak" in the menu-bar panel, or ⌥⌘Q, quits it completely.
- Clicking a notification opens the quick message on that chat. Unsent text
  is kept per chat, and the composer closes when you click elsewhere or
  switch Spaces.
- Refreshing Claude usage reads it with Claude Code's own sign-in and spends
  no tokens.

## 2.1.7

- A compact menu-bar panel in the style of macOS system menus, with grouped
  sections, inset dividers, and full-width actions for messages, chats and settings.
- The panel fits the display it opens on and keeps its actions reachable on
  smaller screens. New chat is available with ⌘N from the panel.

## 2.1.6

- Keep Mac awake with the lid closed, from the menu bar: "Set up lid-closed…"
  asks for your Mac password once (macOS's own prompt), then "Lid closed too"
  sessions start from the popover or your iPhone without asking again. Squeak
  checks the rule allows only its four sleep and Low Power Mode commands
  before installing it.

## 2.1.5

- Notifications say what a session wants: a question ("is asking you
  something", with the question when session names are on), a plan to review,
  or an approval. A second question in a chat that is still waiting notifies
  again.
- Reply to a finished Conductor chat straight from its notification.
- Settings says when macOS is hiding Squeak's banners (alert style None) and
  opens the right pane to fix it.

## 2.1.4

- Quick message (⌘K) is a glass pill: type on top; the chat, its state, repo
  and agent under it, with a round Send. A soft warm light glows from under it
  and breathes while your message sends. ⌥↩ steers a working agent.

## 2.1.3

- The awake session shows on the Mac: what is left beside the duck in the menu
  bar ("1:52", "∞" until you end it), and a Keep Mac awake row in the popover
  to start one, add an hour, or end it.
- When the Mac has switched to your iPhone's hotspot, the popover says so.

## 2.1.2

- Usage bars show what is left, like a battery: "58% left", full once a
  window resets.

## 2.1.1

- A usage window that has reset since its last reading now says Reset and
  draws an empty bar, instead of keeping the old window's number (a 76% bar
  for a window that had just started over).

## 2.1.0

- Answer an agent's question from Squeak: when Claude asks you to choose (one
  option, several, or your own words) or approve a plan, the window and the
  menu-bar panel show it as a card. Squeak delivers your answer to that chat:
  through Conductor when it can, otherwise by stopping the waiting question and
  sending your answer as a message (the card says so first).

## 2.0.9

- Start a new Conductor chat from Squeak: ⌘N, the menu-bar panel or Quick
  message. Pick the workspace and agent, write the first message.
- Finishes and changes show up within a couple of seconds: Squeak watches
  Conductor's database instead of checking on a timer.
- Session headers in two lines; Send holds Steer while an agent works.

## 2.0.8

- Settings › About has Report a problem… to tell us what's broken, confusing
  or could be better (Help › Report a problem still works).

## 2.0.7

- Messages read like documents: headings, lists, tables, code with Copy,
  quotes, and links you can copy but never open by accident.
- Sending shows your message at once with one status line, then what the
  agent is doing ("Running tests…") until its reply arrives. The reply box
  stays put.
- While an agent works, Send becomes Queue (it reads your message after this
  turn), with Steer now to send it into the turn in progress. Each message
  says whether it was sent, queued or steered.
- A chat waiting on a question or a plan now shows as needs you, with the
  question.
- Usage: Claude and Codex limits in the menu-bar panel and the window, with
  Refresh for Claude.
- The menu-bar panel is glass, like the rest of macOS.

## 2.0.6

- Settings › Channels: set up Telegram (paste a bot token, link your chat by
  messaging the bot, send a test message) and Zoho Cliq, without the
  terminal. Saved tokens are never shown again.
- Settings › iPhone: pair Squeak for iPhone with a QR code and approve it on
  the Mac; see and remove paired phones.
- Updates download from sibhimanyu.github.io, which works on networks that
  stall GitHub's release downloads.

## 2.0.5

- Follows Squeak's design guide throughout: the approved duck (facing right),
  the brand yellow, red for "needs you", and plain sentence-case wording.
- Session rows lead with the chat's title, then repo and agent, then what the
  agent is doing right now. Groups: needs you, done, working, error, idle.
- Lucide icons everywhere, the same set as Conductor.
- The menu-bar duck is regenerated from the approved logo.
- Send is ink on light and duck yellow on dark; glass on the reply box, the
  answer rows and Send on macOS 26.
- Help › Report a problem… (⌥⌘R) sends feedback straight to the team.

## 2.0.4

- A new main window: a native three-column layout with a translucent sidebar
  (filters with counts, sources, service status), a session list whose rows say
  what each agent is doing right now ("Running tests", "Waiting for your answer"),
  and a conversation pane with Conversation and Activity tabs.
- Questions with lettered options show as large answer cards with a
  "Recommended" badge; one click sends the letter.
- Liquid Glass on macOS 26 for the reply box, answer cards and Send, with
  fallbacks on older macOS; Reduce Motion and Reduce Transparency are respected.
- The main window and Settings now open on a normal desktop instead of on top of
  another app's full-screen window. The popover and Quick message still appear
  over full screen.

## 2.0.3

- Opening the Squeak window from the menu-bar duck now gives Squeak the menu bar
  (it said "Finder" or whichever app was in front before).
- No more Keychain prompts: the key for the local message cache is now a private
  file beside the cache (0600), not a Keychain item that macOS asked about again
  after every update. The old cache is rebuilt once.

## 2.0.2

Updates install themselves, and Squeak behaves like a real app while its window is open.

- Updates install themselves (Sparkle 2). Squeak checks once a day, downloads a new
  version signed with Squeak's own key, and installs it when you quit or relaunch.
  "Check for Updates…" is in the app menu, the popover's gear menu and Settings,
  About; "Automatically check for updates" is a switch there. This replaces the old
  notice that only linked to the GitHub release.
- While the conversation window, Settings or Welcome is open, Squeak shows a Dock
  icon, appears in Cmd-Tab and has its own menu bar (About, Check for Updates…,
  Settings…, Edit, Sessions, Window, Help). When the last of them closes it goes
  back to the menu-bar duck alone; it never quits. The popover on its own does not
  change this. Clicking the Dock icon with no window open reopens the conversation.
- The build number now grows with every version (2.0.2 is 20002) so updates compare
  correctly.

## 2.0.1

A calmer redesign of every screen.

- New menu-bar icon: a crisp template duck, traced from the brand artwork, that
  follows light and dark menu bars; it shows a count when chats need you and
  dims when Squeak is offline.
- Popover: list-first, grouped as Needs you, Working, Recent and Earlier. A chat
  that needs you shows its question with one-tap answer chips and an inline
  reply. "All quiet" when nothing does.
- Window: a centred reading column; agent replies are plain prose, your
  messages sit on a soft fill; the question that needs you is marked in red with
  answer chips under it; a floating composer.
- Quick message is a Spotlight-style panel; Settings uses native tabs and
  grouped forms; onboarding is shorter and quieter.

## 2.0.0

First release of the native Squeak app for macOS (menu bar, macOS 14+).

What exists:

- A menu-bar popover and a conversation window listing your Conductor chats
  (and, through the Squeak service, Claude and Codex sessions in Terminal),
  grouped as pinned, active and recent, with search over session titles and
  cached messages.
- Conductor chats are read straight from Conductor's own database, read-only,
  so the list and a chat's full history work without the Squeak service.
- Sending a message to a Conductor chat goes through the Squeak service
  (already installed with Squeak 1.x), which types it into Conductor's window.
  If the service is down, sending is disabled and Settings says why.
- Messages render safe Markdown (headings, lists, quotes, code blocks, bold,
  italic, inline code). Links show their address as text and are never
  clickable; no HTML is interpreted.
- Quick message window with an optional global shortcut, drafts that are never
  sent automatically, and notifications that never contain message text.
- Settings › Connections shows each source honestly; Settings › About has
  "Copy diagnostics" (redacted: no message text, titles, paths, ids or tokens)
  and a switch for the update check.
- A daily check against GitHub for a newer release. It shows a notice with a
  link to the release page; it never downloads or installs anything.

Not done or not verified:

- The Swift relay (direct Conductor delivery without the Squeak service) is
  written and tested but not wired in.
- Approvals, attachments and Telegram/Cliq/iPhone channels stay in the Squeak
  service or are unsupported.
- A live send from this app, the global shortcut, notifications and onboarding
  have not been exercised end to end.
- The build is ad-hoc signed and not notarized; Gatekeeper warns on first open.
