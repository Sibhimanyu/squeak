# Changelog

## 2.23.20

- Full screen no longer shows an empty band at the top.
- Updates install themselves: they download in the background and you just restart.
- Check for updates takes you to where you are: Settings if it's open, otherwise the sidebar card.

## 2.23.19

- Ducklings run in the background without holding up the thread: a bar shows each one live, click to watch it, and the dashboard counts them.
- Hover hints show below the button (or above it near the bottom), never on top of what you're about to click.
- Shortcuts follow where you're typing, and Squeak shows it: the terminal lights up when it has the keys, and ⌘T there opens a terminal.
- The preset picker says what each preset does — which model leads, which codes, which runs commands — and shows a check on the one you picked.
- Click the context ring to see how full the chat's context is (used and window, percent), and compact it now.
- Squeak for Web now lives on Squeak's own cloud: the pairing QR opens the new address. Browsers paired with the old address pair once more.
- Account and cloud are one card: signing in also connects this Mac to Squeak's cloud.

## 2.23.18

- Steering is smooth: your steer shows in the stream and the work carries on below it, nothing folds away.
- Steps stay in time order around your steer: what happened before it above the card, what came after below.

## 2.23.17

- After you pick an option, the agent's steps show live under your answer.
- A steer waiting on a helper agent says so.
- Stop clears "Working" at once, even before the agent said a word.
- A steer that was queued instead no longer sits on "Steering…".
- Typing in the composer is kept when you tap an option to answer.
- Steps from before a steer stay folded above it once the chat finishes.
- Answering a question reads Working at once, even after a message sent in the same turn.

## 2.23.16

- What you're typing stays put when the agent asks you to choose, and when you switch chats.
- Stop really stops: the chat stops showing Working, and its background helpers show as stopped.
- A chat keeps its work after Squeak restarts: each turn's thinking, commands and helpers stay, folded under the reply.
- Pictures you attach show as pictures in older messages too.
- In full screen, the window controls appear beside the sidebar controls when you move to the top, like Safari, instead of a separate bar.
- Squeak uses far less CPU and battery: it fetches only what changed and redraws only what moved.

## 2.23.15

- Check for updates shows its progress in the small card at the bottom of the sidebar instead of a big window.

## 2.23.14

- Changes open in a Review view instead of tabs: the changed files on the left, the diffs on the right, Back to chat (or Esc) to return.
- A long diff can no longer cover the chat header and tabs.
- Conductor is now an add-on: Settings › Add-ons lists what Squeak can work with, and Conductor is off until you add it there. After adding it, pick its workspaces again. Until then Squeak does not read Conductor's database and shows nothing from it: no setup step, no "Open in Conductor", no Conductor marks.
- Telegram, Zoho Cliq and Phone calls now sit under Settings › Integrations, so Add-ons means add-ons.
- A pond's colour follows its logo, and a "From the logo" choice in the colour picker puts it back.
- Squeak chats stay usable while Squeak's service restarts, and "Trouble connecting" blips are shorter.
- Notifications: "Finished: Conductor chats" is now "Chats you can reply to".

## 2.23.13

- Much faster and smoother: Squeak redraws far less, stops polling while hidden, and no longer re-lays out the whole chat on every update.
- One motion system: quick, consistent animations for sidebars, panels, tabs and cards, an instant pressed state on every control, and Reduce Motion respected.
- Every way of answering (sending, tapping an option, allowing a request) shows Working at once — in the chat, the sidebar, tabs and the menu bar.
- A chat never looks stuck while the agent works: the working line follows the host, and only new messages are fetched.
- File paths in chat are links: click to open in a tab, right-click to show in Finder or copy the path. Images open in a viewer tab and show as thumbnails on steps; agents can show you a picture.
- Tabs show the agent's own logo; a stream has one name everywhere.
- Your first message reaches the agent sooner, and recent chats stay warm after a restart.

## 2.23.12

- Sending feels instant: the working line and Stop appear the moment you press Send.
- No more Read by Claude lines: a message is faded while it's on its way and turns solid once the agent has it; a failed one shows Retry.
- Messages you send while the agent works wait in a queue above the composer: ↵ steer, E edit, ⌫ delete. ⌘↵ steers straight away.
- A steered message shows Steering… until the agent takes it in.
- The bottom panel is just your terminals, and its divider is easy to grab with the resize cursor.
- The left sidebar's edge line runs the full height.

## 2.23.11

- Scrolling follows new text smoothly while you're at the bottom, and never moves you while you're reading further up.
- Much lighter while a chat streams: finished messages aren't redrawn, so Squeak stays cool and connected.
- If the session host restarts, an open chat reconnects by itself and shows anything it missed.
- Chat history: the clock button searches every chat in the pond, by title and by what was said; open just the one you want.
- Tabs have a width limit, a close button on hover, and ⌘W closes the current tab.
- The Setup · Run · Terminal panel is always at the bottom of the right sidebar and folds down with its chevron or ⌘J.
- The composer shows how much of the context window the chat has used (hover for 142k of 1M).
- The approvals chip is a compact icon; its name and shortcut are in the tooltip.
- A new thread opens straight into its pond with its tab, showing your first message at once.
- A pond's icon is the same everywhere, fills its tile, and updates within seconds when changed.

## 2.23.10

- The working line names the model (Working… · Opus 5.5 · 1M), and helper rows name theirs (Duckling · Sonnet 5.5).
- A turn Claude starts on its own after a helper reports back now shows as working.

## 2.23.9

- Chat text reads like a document: clear gaps between paragraphs and lists, softer text, smaller inline code, a comfortable line width.
- The conversation fades softly into the composer instead of being cut off.
- Pick a preset (Best, Balanced, Save usage) from a chat's model menu.
- Allow edits for this chat: one tap lets the agent edit files inside the workspace without asking each time.
- Shows Retrying… attempt 4 of 10, plain sentences for rate-limit and credit errors, and a quiet Stopped when you stop a turn.
- Stop always ends the turn within a few seconds; typing while the agent works no longer leaves the chat waiting.
- A notification when a chat needs you and you're looking at another one.
- A Claude running in Terminal shows its whole conversation, not just the current step.
- Workspaces show a folder icon in the sidebar; empty Thought rows are hidden.

## 2.23.8

- Chats open at the newest message every time, never on a blank screen.
- Your message and Working… appear the moment you send; the approval card sits right above the composer.
- A chat only says finished when it really is: while helpers run it says Waiting for N background tasks.
- Skip approvals takes effect at once, even for a request already waiting.
- Typing while the agent works steers it instead of restarting it.
- Tighter, Conductor-like spacing; thinking folds into one line.
- Errors read as plain sentences with Retry, never internal error.
- Three shared presets (Best, Balanced, Save usage) set which Claude model plans, codes and runs commands; pick one when you start a thread and edit them in Settings.

## 2.23.7

- Dropdowns, including the model picker, stay attached to their controls when their contents update instead of opening far away.
- The web app has clearer dashboard and phone navigation, easier access to usage, and pond logos in place of decorative color dots.
- A new thread opens straight into its chat instead of saying Squeak no longer lists it.
- Threads started from a pond keep their workspace, so they no longer vanish from the sidebar; ones that did come back.
- Fixes Squeak running hot and freezing while a chat is open: the running timer and the chat layout no longer redraw the whole conversation many times a second.

## 2.23.6

- Squeak cloud now lives in Settings › Account. If this Mac isn't connected yet, press Connect… there; Settings › Cloud is gone.
- Fixes Settings saying you were signed in while still asking you to sign in.
- Model names read the same everywhere, like Opus 5.5 · 1M and GPT 6.1 Sol, instead of raw ids.

## 2.23.5

- Squeak now runs the cloud for you: sign in to Squeak and your phone, browser and Cliq can reach this Mac. There's no Firebase or Catalyst to set up anymore.
- A Mac on its own Firebase, Squeak's old shared server or its own Catalyst relay keeps working, and moves to Squeak's cloud when you sign in; paired devices follow.

## 2.23.4

- A long chat no longer opens to a blank transcript: it keeps scrolling to the newest message until it is on screen.

## 2.23.3

- Fixes the background service never starting on a new Mac. It now starts in under a second instead of quietly exiting.
- Setup shows each stage of the first start and waits patiently on Macs with security software, instead of giving up and undoing the install.
- Fixes a crash on Macs that don't have Conductor installed.

## 2.23.2

- If setup can't start the background service, Squeak says why and offers Send report with the details attached (secrets removed).
- Reporting a problem is easier everywhere: a Report button beside every Try again, a gentle offer when something fails, and reports know your Squeak account so the team can reply.

## 2.23.1

- Setup on a new Mac no longer hangs on starting the background service. It asks to run in the background first, says what it is doing at each step, and if something goes wrong it tells you why with Try again, Copy details and Show log.

## 2.23.0

- New words that fit the pond: a pond's working folders are **streams** (their git branch shown beside them) and an agent's helpers are **ducklings**.
- Every thread is a duck in its own colour, the same on your Mac and iPhone, with a small Claude or Codex badge.
- New streams get names like Mossy Creek or Recursive Mallard; New stream suggests one and can roll another.
- Signing in is a page in Squeak's window. Squeak comes back to the front when you finish in the browser.
- Every thread's agent knows it runs in Squeak, and knows who is talking when several people write in one thread.

- Shared threads show the machine they run on, while local threads keep their own branch and routing.
- Pond settings has clearer sections and shortcuts, wrapping colour choices, an Add label button and collapsible action prompts.
- Dropdowns stay close to the control you clicked, highlight it while open, and stay attached when the window resizes.

## 2.22.3

- Pond dashboards have searchable branches and threads, live summary filters, and a responsive Flock and Ripples column.
- Drag ponds in the sidebar to put them in your own order; the filter menu switches between My order and Recent activity.
- Pond rows show they can be clicked when you hover.
- Check for updates in the sidebar no longer flickers: the icon spins and one line says Checking…, then Up to date.

## 2.22.2

- A pond's page lists every branch the sidebar shows, including new branches with no threads yet, each with a New thread button.

## 2.22.2

- In-app dropdowns, pickers and context menus use Squeak's own menu surfaces, with keyboard navigation, selection marks and shortcut hints.
- New pond and New branch text fields are taller, with more space around the text and a clear focus border.
- The next-thread button says Next update or Next request and aligns with the composer, in its own row so it never covers message text.

## 2.22.1

- Pond settings opens as a page beside the sidebar, with a back button, instead of a dialog. It holds the pond's look, branches, scripts, agents, flock, and Remove from Squeak (files stay where they are).
- A pond's header counts all its threads, and the sidebar can no longer be squeezed too narrow to read.

## 2.22.0

- Checking for updates keeps the sidebar footer buttons in place as the update status changes.
- Back and Forward stay visible when the sidebar is collapsed, and navigation history survives collapsing and reopening it.
- A pond's page shows its branches, the threads on each, and who is in each thread (live while they look or type).
- Three simple pages replace the old Create page and New chat form: Create opens New pond, a pond's + opens New branch (start from the default branch, another branch, a pull request or an issue, picked from real lists), and a branch's + opens New thread. The names you type are used.
- The sidebar can hide ponds, label them and filter by label. Pond settings sets the pond's icon and colour.
- Agents can keep their pond tidy when you ask: set its icon, colour and labels (never hide, rename or invite).
- Squeak's own sessions are threads and a git worktree is a branch everywhere you read; "chat" and "workspace" are Conductor's words.

## 2.21.0

- Conductor is now an add-on you choose workspaces in: Settings › Conductor lists Conductor's workspaces with a switch each, and only the ones you add show in Squeak, in the sidebar with the Conductor mark. Nothing from Conductor shows until you add it.
- Your projects can move from Conductor into Squeak, chats and folders, with `squeak move-from-conductor --repo <name>`.
- Crash reports: after a crash, hang or force quit, the next launch sends a diagnostic report through Heresay by itself (never anything you typed).

## 2.20.1

- The sidebar's update check is a compact icon, and pond disclosure controls are easier to click.
- Resizable pane dividers have larger hit areas and show the appropriate resize cursor on hover.
- Working matrix glyphs use consistent pixel sizes and softly faded edges.

## 2.20.0

- Every project is now a pond. The sidebar says Ponds, and Create says New pond.
- Invite is the only step to share a pond; it signs you in first if you are signed out.
- Ponds are on for everyone. A pond only you can see stays on this Mac until you invite someone.
- Create opens a page in the workspace to start work, add a project or join a pond.
- You can add a profile photo to your Squeak account in Settings › Account.

## 2.19.1

- The Mac menu at the top of the sidebar shows your account (or Sign in to Squeak...) instead of "Connected".
- A warning with Restart appears only when Squeak's service isn't running.
- Clicking the project or workspace in a chat's header opens its dashboard.

## 2.19.0

- The project header, sidebar controls and Pond/Code tabs stay visible in a normal window and after leaving fullscreen.
- The menu bar popup shows one update card with progress and actions, without an old "Updated to" notice competing with a new download.
- Updates can download signed incremental patches from the two recent cached releases, keeping the full download as a fallback. Tested patches were about 98% smaller than the full app.
- A new first-run setup in the new look: Start Squeak, connect your agents, then an optional account and phone. Conductor isn't required.
- Conductor is now an add-on you link in Settings > Add-ons > Conductor. If you already use Conductor, you stay linked.
- Settings uses the sidebar style and is grouped into General, Devices, Add-ons and About.

## 2.18.5

- A long chat no longer opens to an empty transcript: it settles on the newest message, even with very large tool outputs.

## 2.18.4

- Sign in to your Squeak account in Settings > Account (Zoho, Google or email). This Mac then appears in your account, and your iPhone or browser signed in to the same account joins it without a code. You're told each time, with Revoke; "Ask before adding my own devices" brings the code back.

## 2.18.3

- A browser signed in to your Squeak account can ask to be added without a QR code (approve it in Settings > Channels, comparing the code), and Settings shows the account this Mac is linked to, with Unlink.

## 2.18.2

- A web guest who signs in with Zoho, Google or email shows on the join request with their verified email, so you know who you are letting into a pond.

## 2.18.1

- A redesigned menu bar popup matches the desktop workbench, with Chats, Usage and Controls tabs, compact workspace rows, expandable answers and a pinned Open Squeak / Quick message footer.
- Quick message shows its active global shortcut (Control twice by default). Command-K stays with the command palette.
- Dashboard combines the old Home functions into a kanban board: Needs you, In progress, Done and Idle. Filter workspaces, pin them, open the relevant chat or continue your last workspace.
- Back and Forward sit together beside the window controls; the sidebar toggle follows the sidebar's edge.
- The sidebar footer shows the current version, update options and release notes. Checking, download progress, installation and restart actions stay inline when started there.
- After an update, the main window waits for regular app activation and restores its fullscreen capability, so the green button offers fullscreen instead of only Zoom.

## 2.18.0

- The composer's model and effort open a picker, working or idle (⌘/). While the agent works, ↵ queues your message and ⌘↵ steers it; a queued message has its own Steer. Steering a Claude chat stops the turn and starts yours next.
- Each tab shows its agent's mark. The running line and working sidebar rows use Squeak's matrix glyph, clearly visible in light and dark.
- Clicking a changed file opens its whole diff in a tab; View all changes stacks every file with a jump menu.
- Hover a button to see its name and shortcut. One list drives the menus, the hints and the shortcut sheet, with new shortcuts for tabs, panels and the composer. Full screen works from the green button and ⌃⌘F.
- The right panel opens on the Pond panel: who's here, this thread, what needs you, the project's other threads, Ripples and what changed. Files, Changes, Review, Setup, Run and Terminal sit behind Code (⌥⌘C).
- Ponds, a preview of sharing a project with other people, are built in but stay off unless turned on.

## 2.17.2

- The sidebar and right panel buttons live inside their panels while open and wait at the edge of the chat header while closed, always at the same height. Panels slide open and closed and the button travels with them (Reduce Motion fades instead). ⌘B for the sidebar, ⌥⌘B for the right panel.

## 2.17.1

- A chat's tab shows Squeak's matrix glyph only while its agent works, and nothing once it's done.
- The right panel is one colour, terminal included.
- The chat and the composer sit in a centred column with wider margins on both sides.
- The Background bar no longer repeats itself: one line when folded, one list of tasks when open.

## 2.17.0

- A new look, closer to the workbench you know: an opaque warm palette in light and dark, without the tinted glass.
- A new sidebar: back and forward, your Mac at the top, then Dashboard, Home, Create and Search. Your workspaces follow, each repository with a + and each chat with its title and its added and removed lines. Agent sessions from other folders sit in one folded Other sessions group instead of looking like projects.
- The chat header shows repository › branch with the target branch. Tabs have grips, an underline on the open tab, + for a new chat and a button to reopen a closed one.
- The chat reads as a flow of Thinking and command rows, with a running clock and Next unread on the last line.
- A taller composer with the model and effort on the left and attach, usage, dictation and send on the right; ⌘L focuses it.
- The right panel has Create PR above it, All files, Changes and Review, and a lower half with Setup, Run and Terminal (⌘J). Checks moved into the pull request menu.

## 2.16.0

- A warmer palette and larger reading type throughout the conversation.
- Messages and turns have new footers: copy, time and what the turn changed.
- The right panel has tabs: All files, Changes, Checks, Review, Setup and Run. Changes still shows the agent's review comments.
- The sidebar has Home, pinned chats and change counts beside each workspace.
- Close a tab and reopen it again. A pill offers the next chat that needs you.
- New shortcuts: ⌃O opens or folds every step in every turn (each turn's Expand all still works for that turn alone), ⇧⌘L, ⌥⌘L and ⌘L, ⇧⌘H for Home, and ⇧⌘. for zen mode.
- Rules moved to the chat header, and Home shows your projects at a glance.

## 2.15.1

- Review comments are one list: the agent reads what you leave in Changes, its comments appear there marked Agent, and you can resolve them.
- Background subagents show their steps, a running mark and their answer.
- Chats show Claude's thinking summaries.
- Expand all opens every tool call in a turn.
- Project settings can set a separate model for reviews; Review then starts its own chat on it.
- Agents can read a workspace's run and setup output. Show in Finder works on workspaces.
- Squeak no longer changes Conductor's settings or Keychain. Replies to Conductor chats go through its window, or the background route when it can't be typed into. If an earlier version had linked Conductor to Squeak, Squeak undoes that the first time it starts; restart Conductor once after.

## 2.15.0

- Squeak's chats can see and do more: every agent can read the workspace's whole diff, read and leave review comments, page you, keep a progress tracker above the composer, and change the branch the work merges into.
- Agents can work together: one chat can find, read, message and start other Squeak chats on this Mac. Every message shows in both chats, marked with who sent it, and a chat that is started never gets wider permissions than the one that started it.
- Subagents open to show their own steps and answer, and tool output and edits now open under their rows in the chat.
- New actions: Pull latest and Write changelog. Create PR, Review, Fix errors and Resolve conflicts give the agent clearer steps and use your own skills first.
- A bundled Squeak skill teaches every Claude chat how to work inside Squeak, and the / picker lists your skills with their descriptions.
- Clone a repository, start a workspace from a branch, a pull request or an issue, and show a project in Finder, from the sidebar.
- Project settings hold a backlog of ideas to start later, and routines: a prompt that starts a chat every few hours, daily or weekly.

## 2.14.3

- A denser sidebar in the style of Conductor: tighter project, worktree and chat rows, a chevron and worktree count on project headers, and a softer selected row.
- A working chat shows the pixel matrix as its mark in the sidebar, the menu-bar panel and the command palette, and holds still when the window is in the background or Reduce Motion is on.

## 2.14.2

- Running chat tabs show a crisp monochrome pixel matrix beside the title and provider marker, with softly fading edges.
- Chat tabs keep their positions through activity updates, workspace switches and app relaunches. New chats append on the right; drag a tab onto another to move it before that tab.

## 2.14.1

- Matrix activity fades softly to transparent on every edge, with crisp pixels and no visible box boundary.

- Running tabs and worktrees now show an abstract animated pixel matrix: flowing cells and fading trails, with no letters or punctuation. Reduce Motion keeps the pattern still.

## 2.14.0

- Git from the chat: a branch line in the header with one button that follows the work (Create PR, Fix errors, Resolve conflicts, Merge with a confirm, Merged), a PR tab, and ⌘⇧P / Y / M / X / R. The agent does the git work, as in Conductor.
- Workspaces run their project's setup script before the first message (an existing conductor.json works too), have a Run button with their port, a setup log, and Archive that never throws away uncommitted work. A new workspace's branch is named from its first message. Project settings hold the scripts, branch prefix, merge method and prompts.
- Every turn is checkpointed: hover a message to Restore its files, Fork the chat from there, or Edit it. Your branch, index and stash are never touched.
- Allow for this chat on approval cards, with the chat's rules listed in the Activity tab. ↵, ⌫ and 1-9 answer a card when the composer is empty.
- A terminal at the bottom of the window (⌘J), one per workspace.
- @ inserts a file and / a command in the composer. ⌘K is a real palette over chats, projects and actions; ⌘⌥/ lists every shortcut.
- The Files tab is a file browser and editor; comments on diff lines go to the chat as one review.
- The sidebar and inspector can be resized, and a project's + makes a new workspace.

## 2.13.3

- The sidebar now shows project artwork and larger names. Worktrees open directly; chats live only in their workspace tabs.
- Squeak, sidebar collapse, search and Open project are at the top; connection, Usage and Settings stay at the bottom.
- Running worktrees and chat tabs carry a quiet moving glyph field instead of status dots or spinners. Unread finishes use bold text. Reduce Motion keeps the glyphs still.
- Sent messages stay inside the centered conversation column, including in wide windows. New chat opens in the chosen workspace.

## 2.13.2

- The coloured dots are gone. Lists are grey, and a small glyph shows up only when something is going on: a dot-grid loader while an agent works, an amber triangle for an approval or a plan, a speech bubble for a question, a red × when it failed.
- The one dot left is the blue one on a finished chat you haven't opened.
- Approval and plan cards have an amber edge, and question cards a grey one.

## 2.13.1

- Lists say less and show more: a chat row is its title and age, and one small mark takes the age's place when something is going on: a spinner while it works, a red dot when it waits for you, a blue dot until you open a finished chat, a violet × when it failed. Hover a mark to read it in words.
- No more "Needs you" group or state words in the sidebar, the tabs or the menu-bar panel; every list stays newest first and a chat never jumps because of its state. A folded project or workspace shows the mark of whatever inside wants you most.
- Approval, plan and question cards just ask: "Run a command that deletes a folder", "Claude's plan", or the question itself.
- The working row shows what the agent is doing right now ("Editing store.ts · 1m 12s") and sits above the composer, so it is never cut off.
- Conductor chats carry Conductor's icon.

## 2.13.0

- A new workbench window: projects, then workspaces, then chats down the sidebar, with a Needs you group on top for everything waiting on you. Each workspace's chats are tabs across the top.
- An inspector beside the chat with Changes, Files and Activity, so you can see what the agent changed and what it is doing without leaving the chat.
- A redesigned transcript and composer: calmer message blocks, tool steps folded into the turn, and one composer for text, images, model and effort.
- Squeak's own chats: press ⌘N to start a Claude or Codex chat in a new worktree named after a bird, in an existing workspace, or in any folder.
- Approvals, plans and questions arrive as cards you answer with a tap or a key; a plan you can read in full before you approve it.
- Set the mode and model, stop a turn, and queue or steer a message while the agent works.
- Chats update live as the agent works, and the New chat sheet fits its content.
- Squeak's own chats use the Claude Code and Codex already on this Mac (set `CLAUDE_BIN` / `CODEX_BIN` to point elsewhere) and run in the Squeak session host, which Squeak installs and starts beside its background service and never restarts while a chat is working or waiting on you; Conductor chats work as before without it.

## 2.12.48

- One composer, like a chat app: your text on top, then + for images, the model and effort, a mic, and a round Send. The model menu moved down into it.
- Voice: press the mic (or ⇧⌘D), speak, and the words land in the box to check before you send. It is transcribed on this Mac where it can be, and nothing is sent by itself.
- A question waiting on you is one card. While it waits, the composer folds to "Write a different message instead", a question answered on another device says "Answered elsewhere", and a tool waiting for approval in Conductor says so with an Open in Conductor button.
- More room for the conversation: sources are one menu in the sidebar, the session list can be hidden (⌥⌘L), the sidebar folds to icons in a narrow window and remembers how you left it, and the header is shorter, with branch, changes and context behind an ⓘ button.
- Choose whether Send queues or steers while the agent works (Settings › Sending). ⌘↩ does your choice and ⇧⌘↩ the other; the quick composer and the menu-bar panel follow it too, and the choice is shared with your iPhone.
- A message sent while the agent works shows as queued straight away, and Steer and Delete answer at once.
- Chats and the Activity tab open at once and say they are loading, instead of "No messages yet" while they read.
- A message you send while the agent works, from here, Conductor or your phone, now shows in the turn's steps where it landed instead of wiping them.

## 2.12.47

- A chat's header shows how much of its context it has used ("39% context"), in red from 80%.
- Switch the Claude account from the menu-bar panel's Usage section, if you use `claude-swap`: your saved accounts are listed with the active one ticked. New chats use the account you pick; chats already running keep theirs until they restart.

## 2.12.46

- The install disk image no longer puts Uninstall Squeak on top of the install steps: it has its own row below them, with a line saying what it does.

## 2.12.45

- Wherever Squeak shows an error (setup, sending a message, new chats, updates, Settings for Cloud, Channels, Conductor, Voice, Keep awake and Notifications, the menu-bar controls), a Report button opens a report with the problem already written in, ready for you to read and send to the Squeak team. A setup that can't start the background service attaches its technical details too. Report a Problem (⌥⌘R) and Settings' Report a problem now open in front of whichever window you're in, including setup, instead of only the main window.

## 2.12.44

- Setup says why when the background service won't start, in plain words with what to do (an Intel Mac, security software blocking it, another app on Squeak's port, damaged files, a slow first start), with Copy details and Show log instead of a path to a log file. Setup picks up where you left off: quit or close it halfway and it carries on connecting by itself next time, remembers why the last try failed, and a service left half-installed is started again at launch. Connect has Finish later, and gets 40 seconds for a first start instead of 20.

## 2.12.43

- Settings has a Cloud tab: choose where your phone and this Mac meet, Firebase or Zoho Catalyst. Each has a card with its status (In use, Ready, Not set up), a Test that shows write, read and change-notice times (side by side once both have been tested), and Use this, which moves paired devices over after you confirm. Firebase setup moved here from the iPhone page, with Rename. Catalyst has a step-by-step checklist (command line tool, project, table, deploy, change notices, test), with every command and value to type in the console one tap to copy. The tab appears once the Squeak service on this Mac supports it.

## 2.12.42

- Call voices are named, not described (Heart, Emma, Grace…), and Kokoro, Ming and Chatterbox share one list of voices; each copy was checked for clarity over a phone line, and Squeak makes the short reference clips it needs by itself. A Ming voice picked before moves to the nearest one.

## 2.12.41

- Clicking a notification for a question shows its options as buttons (one tap sends the letter), with the full message behind Show context. Notifications now lead with the chat's state (Finished, Asking you something, Needs your approval, Plan to review, Hit an error) and carry the chat's name as the subtitle.

## 2.12.40

- Settings › Phone calls has two new switches: Answer menus by voice (say a workspace or chat instead of pressing a number; keys still work) and Offer the chat that's waiting on you first (a call starts with the chat that needs you). A custom character now says that Squeak asks Claude once, on your Mac, to write the waiting lines when you save it.

## 2.12.39

- Settings › Phone calls › Voice has a Speed control under Emotion: 0.8× to 1.3×, for every voice engine. Squeak makes the voice at its natural pace and then speeds it up or slows it down without changing the pitch; the call prompts are recorded again at the new speed, and Play sample uses it.
- Calls (with the Squeak Voice add-on 0.20.0): you answer the menus by saying a workspace or chat, the waiting lines follow the character you set, spoken answers no longer stop mid-sentence (the Mac starts one only once the rest can keep up), and a call in goes straight to "Which workspace?". Play sample works while the call prompts are being recorded.

## 2.12.38

- Call history has a clearer list and timeline: choose a call to see its outcome, conversation and warnings, with technical events available when needed.
- Phone calls keep their state if the daemon restarts. With the Squeak Voice add-on 0.19.0, recordings upload while you speak and read-back starts sooner.

## 2.12.37

- Start a new chat from a phone call: pick a workspace, press 0, say what it should do, and say yes to the read-back. Settings › Phone calls › New chats picks which of your Conductor model presets (and thinking level) those chats use. Needs the phone-call add-on 0.18.0.
- Calls name a workspace by its repo and branch ("squeak, fix parser") instead of Conductor's city folder name.

## 2.12.36

- Settings › Phone calls › When to call: choose how long Squeak waits before ringing, when it counts you as away from the Mac, how long it holds a call while you're at the Mac, or turn holding off. New: if you were at the Mac when the question came, Squeak waits until you've been away 3 minutes (your choice) before ringing, since you likely saw it.
- Calling in: spoken answers start after their first sentence instead of after the whole answer, Squeak stops listening sooner after you finish talking, and it offers "the last one you used" only for a chat from the last two hours (else the one waiting on you). Needs the phone-call add-on 0.17.0.

## 2.12.35

- Settings › Voice says when a new voice is ready for calls. After you change the engine, voice or emotion, Squeak loads the voice, re-records the call prompts and sends them to the phone add-on; the line shows each step ("recording call prompts, 12 of 34…") and then "ready for calls". Until then a call may still use the old voice.
- Play sample works again after switching engines; it could get stuck and keep saying it couldn't play.

## 2.12.34

- Qwen3-TTS has four more call voices: Anna, and three designed ones, a warm American woman, a calm deep British man and a friendly Indian-English woman. Each keeps the same voice through a whole call while its emotion follows what the line says.
- Settings › Voice: choosing a voice engine and its voice is clearer, and Setup and Settings move between each other more smoothly.
- The sidebars show Telegram's and Cliq's own app icons.

## 2.12.33

- Settings › Voice: choose the voice engine for calls. Kokoro (today's voice, fast and plain) stays the default; Qwen3-TTS, Ming and Chatterbox are expressive and sound urgent, cheerful, apologetic or warm to suit what each line says. Each has its own voices, an Emotion setting (Off, Subtle, Strong), Play sample, and Set up / Remove. Setting one up uses model files already on this Mac when it has them.

## 2.12.32

- Settings › Phone calls › How it talks: pick Terse (the new default: no greeting, no thanks, short and direct), Friendly, or describe a character of your own. It changes the tone and wording of what Squeak says on a call; what it can read or do stays the same. Applies from the next call.

## 2.12.31

- Checking for updates when Squeak is already current now says so: "You’re up to date, Squeak 2.12.31 is the latest version" instead of an empty "Squeak Update" card, and the update window shows the version you are running.

## 2.12.30

- The menu bar popup now shows a phone-call add-on update the way it shows an app update: "Phone-call add-on 0.11.7 is available" with Update, then progress, then "Updated to …" with Dismiss. The popup checks once a minute, so you no longer have to open Settings to see it.

## 2.12.29

- Phone calls: Update add-on now waits up to 15 minutes for Home Assistant to install and restart the add-on (a small Home Assistant machine takes several), and if it still says it did not update, keeps watching and changes to "Updated" when the new version reports in.

## 2.12.28

- Phone calls: pressing Update add-on shows "Updating the add-on…" at once and keeps the page responsive while Home Assistant is asked, instead of leaving a dimmed button.

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
