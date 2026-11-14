// All copy and links for the Squeak page. Plain values only: the build
// escapes every token, so nothing here may contain markup.
// Release facts (version, file, URL, minimum macOS) come from release.json,
// which the release tooling keeps in step with the published appcast.
// Words follow DESIGN.md section 9: pond, stream, thread, duckling, flock, nest,
// egg, quack, ripples. Each playful word is explained in plain words beside it.

import release from "../release.json";

const version: string = release.version;
const dmg: string = release.fileName;
const download: string = release.downloadUrl;
const minMacOS = `macOS ${String(release.minimumSystemVersion).split(".")[0]} or later`;
const canonical = "https://sibhimanyu.github.io/squeak/";
const releases = "https://github.com/Sibhimanyu/squeak/releases/latest";
const iphoneSetup = "https://sibhimanyu.github.io/squeak/ios/";
const moreProjects = "https://sibhimanyu.github.io/";
const webApp = "https://squeak-60083782173.development.catalystserverless.in/app/index.html";

const content = {
  site: {
    lang: "en",
    title: "Squeak: your agents, your flock, in view",
    description:
      "Squeak runs your Claude and Codex threads on your Mac, tells you the moment one needs you, and lets you answer from your Mac, iPhone, a web browser, Telegram, Zoho Cliq or a phone call. Share a project as a pond and invite your flock.",
    canonical,
    ogTitle: "Squeak: your agents, your flock, in view",
    ogDescription:
      "Squeak runs your Claude and Codex threads on your Mac and tells you the moment one needs you. Answer from anywhere, and invite your flock.",
    ogImage: `${canonical}assets/og.png`,
    ogImageAlt: "Squeak: Your agents. In view. A yellow rubber duck beside the headline.",
    themeColor: "#F8F7F3",
  },

  release: {
    version,
    file: dmg,
    download,
    releases,
    requirements: minMacOS,
    price: "Free",
  },

  nav: {
    skip: "Skip to content",
    homeLabel: "Squeak home",
    mainLabel: "Main",
    threads: "Threads",
    threads_href: "#threads",
    needs: "Needs you",
    needs_href: "#needs",
    ponds: "Ponds",
    ponds_href: "#ponds",
    away: "Away",
    away_href: "#away",
    download: "Download",
    download_href: "#install",
    logoAlt: "Squeak",
  },

  hero: {
    kicker: "Squeak for Mac, iPhone and web",
    line1: "Your agents.",
    line2: "Your flock.",
    line3: "In view.",
    lede: "Squeak runs your Claude and Codex threads on your Mac, tells you the moment one needs you, and lets you answer from anywhere.",
    cta: "Download for Mac",
    ctaHref: download,
    secondary: "See how it works",
    secondaryHref: "#threads",
    meta: `Version ${version} · ${minMacOS} · Apple silicon · Free`,
    duckAlt: "Squeak's mascot, a yellow rubber duck with an orange bill, looking to the right.",
    previewLabel: "Squeak, the storefront pond with four example threads",
    previewTitle: "storefront",
    previewStatus: "1 needs you",
    previewNote: "Example threads",
    stageDescription:
      "Decoration: a pile of Squeak's rubber duck mascot drops into view and settles beside an example Squeak panel. Moving a pointer over it nudges the ducks.",
  },

  // The example thread used everywhere on the page (hero, window, moment, phone, Telegram).
  sessions: {
    payment: {
      title: "Payment retry logic",
      agent: "Claude",
      needs: "Claude · waiting for your answer",
      age: "2m",
    },
    search: {
      title: "Search index rebuild",
      agent: "Codex",
      working: "Codex · working",
      age: "just now",
    },
    onboarding: {
      title: "Onboarding link",
      agent: "Codex",
      working: "Codex · editing 2 files",
      age: "18m",
    },
    webhook: {
      title: "Webhook checks",
      agent: "Claude",
      working: "Claude · running tests",
      age: "12m",
    },
  },

  // ---- 01 Threads: the Mac window ------------------------------------
  threads: {
    kicker: "01 / Threads",
    heading: "Claude and Codex, running on your Mac.",
    lede: "Squeak runs your agents itself. A thread is one agent on one task, working in its own stream: a git worktree, with its branch beside it. A separate session host keeps a running turn alive when the app closes or updates.",
    windowLabel: "An example Squeak for Mac window. Ponds are listed in the sidebar. The open thread, Payment retry logic, is waiting for approval to run a command, with two ducklings working in the background and a message box below.",
    win: {
      pondsLabel: "Ponds",
      pond1: "storefront",
      stream1: "checkout",
      branch1: "payment-retries",
      thread1: "Payment retry logic",
      stream2: "search",
      branch2: "search-index",
      thread2: "Search index rebuild",
      pond2: "atlas",
      pond3: "compass",
      create: "New pond",
      barPond: "storefront",
      barStream: "checkout",
      barBranch: "payment-retries",
      barDiff: "+54 −9 · 3 files",
      you: "Retry failed payments before showing an error.",
      said: "I'll add retries to the payment client and check them against the gateway.",
      toolEditVerb: "Edit",
      toolEditTarget: "retry.ts",
      toolEditMeta: "+18 −2",
      toolRunVerb: "Run",
      toolRunTarget: "npm test payments",
      toolRunMeta: "6s",
      cardTitle: "Run a command that needs the network",
      cardChip: "Bash",
      cardCommand: "npm test -- payments --live",
      cardReason: "“Run the live gateway tests to check the retry timing.”",
      allowOnce: "Allow once",
      allowOnceKey: "↵",
      allowThread: "Allow for this thread",
      allowThreadKey: "⌘↵",
      deny: "Deny",
      bgLabel: "Background",
      duck1: "check callers",
      duck1Age: "2m",
      duck2: "update docs",
      duck2Age: "40s",
      placeholder: "Allow or deny above, or tell Claude what to do instead",
      model: "Opus 5.5",
      mode: "Ask",
      context: "ctx 38%",
      hint: "Queued messages wait for this turn. ⌘↵ steers it.",
      panelPond: "Pond",
      panelCode: "Code",
      panelHere: "Who's here",
      panelYou: "You",
      panelNest: "This Mac",
      panelAgent: "Claude · Opus 5.5",
      panelNeeds: "Needs you",
      panelNeedsRow: "Payment retry logic is waiting for your approval",
      panelChanged: "What changed",
      panelChangedRow: "Changed 3 files, +54 −9",
    },
    c1: {
      n: "1",
      title: "Ponds, streams and threads",
      body: "Every project is a pond. Each thread works in a stream, so two threads never share a folder by accident.",
    },
    c2: {
      n: "2",
      title: "Answer where it asks",
      body: "Approvals and questions are cards in the thread. Allow once, allow for this thread, or type your own answer. Keys work too.",
    },
    c3: {
      n: "3",
      title: "Steer while it works",
      body: "Queue a message with Return, or steer the running turn with Command-Return. Ducklings and background work show live under “What it's doing”.",
    },
    toolsTitle: "Every agent gets Squeak's tools",
    toolsBody:
      "The workspace diff, review comments, notify, progress, and a way to list, read and message other threads, or start one. A thread can ask another for help.",
    alsoLabel: "Also in the window",
    also: {
      i1: "Checkpoints and revert",
      i2: "Fork a thread",
      i3: "Edit an earlier message",
      i4: "Commit and push, create PR, merge, fix errors, review",
      i5: "Diff view and diff comments",
      i6: "File browser and editor",
      i7: "Built-in terminal ⌘J",
      i8: "Command palette ⌘K",
      i9: "@file and / command pickers",
      i10: "Streams from a branch, PR or issue",
      i11: "Backlog and routines",
      i12: "Setup and run scripts",
    },
  },

  // ---- 02 Needs you: the pinned moment -------------------------------
  needs: {
    kicker: "02 / Needs you",
    heading: "It tells you the moment a thread needs you.",
    lede: "A thread asks, and the question reaches you wherever you are. Squeak calls that notification a quack.",
    stepsLabel: "Four steps of the example",
    replay: "Replay example",
    note: "Example only. Nothing is sent.",
    status: {
      working: "Working · 1m 12s",
      question: "Waiting for your answer",
      answered: "Working · 2s",
      finished: "Finished",
    },
    stream: "storefront / checkout",
    branch: "payment-retries",
    b1: {
      n: "1",
      title: "A thread is working.",
      body: "Payment retry logic is changing the checkout's retry code. Nothing needs you, so Squeak stays quiet.",
    },
    b2: {
      n: "2",
      title: "Then it needs you.",
      body: "The thread asks how temporary failures should be retried. A quack reaches your Mac, iPhone, Telegram or Cliq with the question and its options.",
    },
    b3: {
      n: "3",
      title: "You answer from where you are.",
      body: "A person chooses A, with one tap or one key. The answer goes to that thread, and nowhere else.",
    },
    b4: {
      n: "4",
      title: "The thread carries on.",
      body: "It continues the work and tells you when it finishes, with what changed on disk.",
    },
    w1: {
      you: "Retry failed payments before showing an error.",
      said: "I'll add retries to the payment client.",
      toolVerb: "Edit",
      toolTarget: "retry.ts",
      toolMeta: "+18 −2",
      live: "Editing retry.ts · 1m 12s",
      placeholder: "Add a follow-up. Claude reads it after this turn",
    },
    w2: {
      said: "Before I go further, one decision is yours.",
      cardTitle: "How should temporary failures be retried?",
      optA: "Retry with backoff, up to 3 times",
      optARec: "recommended",
      optB: "Fail at once and show the error",
      other: "Or write your own answer",
      placeholder: "Answer above, or write your own answer",
      toast: "storefront · checkout is waiting for your answer",
      toastLabel: "Quack",
    },
    w3: {
      said: "Before I go further, one decision is yours.",
      receipt: "Answered A · 14:06",
      receiptOpt: "Retry with backoff, up to 3 times",
      live: "Thinking · 2s",
      placeholder: "Add a follow-up. Claude reads it after this turn",
    },
    w4: {
      said: "Retries now back off 1s, 2s, 4s, then fail with the gateway's own error. Tests pass.",
      toolVerb: "Run",
      toolTarget: "npm test payments",
      toolMeta: "6s",
      footer: "1m 19s · 4:03 PM",
      changed: "Changed 3 files, +54 −9",
      placeholder: "Message Claude in checkout",
      toast: "storefront · checkout finished",
      toastLabel: "Quack",
      toastBody: "Retries now back off 1s, 2s, 4s. 3 files changed.",
    },
  },

  // ---- 03 Ponds ---------------------------------------------------------
  ponds: {
    kicker: "03 / Ponds",
    heading: "Every project is a pond. Invite your flock.",
    lede: "A pond starts on your Mac and stays there, with no cloud involved, until you invite someone. Then the people in it, your flock, can watch the work live, message the threads and answer their questions.",
    homeLabel: "A pond, as Squeak draws it. Example only.",
    home: {
      title: "storefront",
      kind: "Pond",
      access: "Shared with 3 people. Anyone you invite sees threads live.",
      invite: "Invite",
      flock: "Flock",
      m1: "Asha (you)",
      m1Where: "Online · This Mac",
      m2: "Ravi",
      m2Where: "Typing · Ravi's MacBook",
      m3: "Meera",
      m3Where: "Viewing Payment retry logic · web",
      streamsLabel: "Streams and threads",
      stream1: "checkout",
      stream1Branch: "payment-retries",
      thread1: "Payment retry logic",
      thread1State: "Claude · waiting for your answer",
      thread1Who: "Asha · This Mac",
      thread2: "Refund webhook",
      thread2State: "Codex · waiting for Ravi to approve",
      thread2Who: "Ravi · Ravi's MacBook · shared",
      stream2: "search",
      stream2Branch: "search-index",
      thread3: "Search index rebuild",
      thread3State: "Codex · working",
      thread3Who: "Asha · This Mac",
    },
    glossaryLabel: "Words used in Squeak",
    g: {
      pond: { term: "Pond", body: "A project. Where its threads live." },
      flock: { term: "Flock", body: "The people in a pond, and their agents." },
      stream: { term: "Stream", body: "A folder of work in a pond (a git worktree), with its branch beside it." },
      thread: { term: "Thread", body: "One agent on one task. Each gets its own coloured duck." },
      duckling: { term: "Duckling", body: "A helper a thread starts for short internal work, like a subagent." },
      nest: { term: "Nest", body: "The Mac where someone's agents run." },
    },
    ways: {
      label: "Two ways to work together",
      own: {
        title: "Your own thread, on your own Mac",
        body: "Everyone works in their own stream and their own folder. The code moves through Git, as it always has.",
      },
      shared: {
        title: "Chat in someone's shared thread",
        body: "It runs on their Mac, so only messages travel. Nobody's files are copied.",
      },
    },
    rules: {
      r1: "Members read threads live and see the diffs.",
      r2: "They can message a thread and answer its questions.",
      r3: "Approvals, and stopping a thread, stay with the person who started it.",
      r4: "Web guests join from an invite link in the browser with their Squeak account. No app needed.",
    },
  },

  // ---- 04 Away from your desk -----------------------------------------
  away: {
    kicker: "04 / Away from your desk",
    heading: "Step away. Stay in the loop.",
    lede: "Answer, approve and start threads from your iPhone, in a browser, in Telegram or in Zoho Cliq. Squeak can even ring you.",
    phoneLabel: "Squeak for iPhone, an example screen",
    phone: {
      time: "9:41",
      pond: "storefront",
      needsLabel: "Needs you",
      title: "Payment retry logic",
      question: "How should temporary failures be retried?",
      optA: "A  Retry with backoff",
      optB: "B  Fail at once",
      workingLabel: "Working",
      working1: "Search index rebuild",
      working2: "Onboarding link",
      tabHome: "Home",
      tabThreads: "Threads",
      tabNeeds: "Needs you",
      tabSettings: "Settings",
    },
    telegramLabel: "A Telegram card for the example thread",
    telegram: {
      from: "Squeak",
      title: "storefront · checkout",
      state: "waiting for your answer",
      question: "How should temporary failures be retried?",
      changed: "3 files changed",
      buttonA: "★ A",
      buttonB: "B",
      buttonReply: "Reply",
      buttonFull: "Full message",
      caption: "Telegram card, example thread",
    },
    listLabel: "Ways to reach you and your Mac",
    iphone: {
      title: "iPhone",
      body: "Answer and approve, start threads, and watch a turn live with Show thinking. Mac controls: volume, brightness, fans, apps, keep awake and energy mode.",
    },
    web: {
      title: "Squeak for Web",
      body: "Open it in any browser. Guests join a pond from an invite link, with no app.",
    },
    cards: {
      title: "Telegram and Zoho Cliq",
      body: "A card with the question and one-tap answers, and a reply that goes to the right thread.",
    },
    calls: {
      title: "A phone call",
      body: "Squeak can ring you when an agent waits. Hear the question and answer on the keypad. It needs a SIP phone system that you set up.",
    },
    awake: {
      title: "Keep awake",
      body: "A keep-awake session keeps the Mac working, even with the lid closed, and ends on low battery or heat.",
    },
    path: {
      title: "Direct, or sealed",
      body: "On the same Wi-Fi your phone talks to the Mac directly. Anywhere else it goes through an end-to-end sealed relay.",
    },
    requirement: "Replies go through your Mac, so it needs to be on with Squeak running.",
    link: "Set up the iPhone app",
    linkHref: iphoneSetup,
    linkNote: "It installs through SideStore. Or",
    webLink: "open Squeak for Web.",
    webHref: webApp,
    callsDocs: "Phone call setup",
    callsDocsHref: "https://github.com/Sibhimanyu/squeak/blob/main/docs/voice.md",
  },

  // ---- 05 Trust -----------------------------------------------------------
  trust: {
    kicker: "05 / Trust",
    heading: "Your Mac stays in charge.",
    lede: "Squeak is local first and works with no cloud. A phone or a browser is trusted by its key, never by a server.",
    t1: {
      title: "Signed, or ignored.",
      body: "Every command is signed by a paired device, expires within ten minutes, and is checked once.",
    },
    t2: {
      title: "You approve each device.",
      body: "Pairing waits for your approval on the Mac. Your own signed-in devices can join by themselves, with a notice you can revoke.",
    },
    t3: {
      title: "Accounts identify. Keys decide.",
      body: "Sign in with Zoho, Google or email to find your devices and your flock. An account never authorises a command.",
    },
    more: {
      summary: "More about what stays on your Mac",
      d1: {
        title: "Local first",
        body: "Threads, files and ponds live on your Mac. A pond makes no network call until you invite someone.",
      },
      d2: {
        title: "Sealed in transit",
        body: "Away from home, messages cross a relay that cannot read them. At home they go straight to the Mac.",
      },
      d3: {
        title: "Its own engine",
        body: "Squeak's engine is its own. Its hooks never block your agents.",
      },
    },
  },

  // ---- Extensions -----------------------------------------------------------
  extensions: {
    kicker: "Extensions",
    heading: "Off until you turn them on.",
    body: "Add them in Settings › Extensions.",
    e1: { title: "Conductor", body: "See and answer your Conductor chats in Squeak." },
    e2: { title: "RasanAI", body: "Follow and answer film director runs." },
  },

  // ---- Where it's going -----------------------------------------------------
  next: {
    kicker: "Where it's going",
    heading: "Coming, not here yet.",
    lede: "These are plans, and they may change.",
    badge: "Coming",
    i1: { title: "Eggs", body: "Ideas on a pond's board that you hatch into threads." },
    i2: { title: "Ripples", body: "An activity feed for each pond." },
    i3: { title: "Shared Nests", body: "Members lend their Mac to a pond, and work is scheduled onto it." },
    i4: { title: "Handoff", body: "Move a thread from one Mac to another." },
    i5: { title: "Claims and locks", body: "Two agents don't edit the same thing at once." },
    i6: { title: "A pond-first home", body: "A start screen built around the pond and what needs you." },
  },

  // ---- Install ----------------------------------------------------------------
  install: {
    kicker: "Install",
    heading: "Start your pond.",
    pondDescription:
      "Decoration: a small pile of Squeak's rubber duck mascot pours into a box and settles. Moving a pointer over it nudges the ducks.",
    lede: `Squeak ${version} for Mac, as a disk image. It is free and signed with an Apple Development certificate, but not notarized; macOS may ask you to allow it on first launch. After that, Squeak updates itself.`,
    cta: "Download for Mac",
    ctaHref: download,
    ctaFile: dmg,
    releases: "All releases",
    releasesHref: releases,
    iphone: "iPhone app",
    iphoneHref: iphoneSetup,
    stepsLabel: "Install in three steps",
    s1: {
      n: "1",
      title: "Open the disk image",
      body: `Open ${dmg} from your Downloads and drag Squeak onto Applications.`,
    },
    s2: {
      n: "2",
      title: "Open it the first time",
      body: "Right-click Squeak in Applications, choose Open, then Open again. If macOS still refuses, press Open Anyway in System Settings › Privacy & Security.",
    },
    s3: {
      n: "3",
      title: "Open a folder as a pond",
      body: "Choose a project folder and Squeak lists it under Ponds. Start a thread with Claude or Codex, and pair your iPhone from Settings.",
    },
  },

  footer: {
    by: "Squeak, by",
    author: "Sibhimanyu",
    authorHref: moreProjects,
    more: "More projects",
    moreHref: moreProjects,
    releases: "Releases",
    releasesHref: releases,
    web: "Squeak for Web",
    webHref: webApp,
    thanksPre: "Thanks to",
    person: "Charlie Holtz",
    personHref: "https://x.com/charlieholtz",
    thanksPost: "for building Conductor, which Squeak's Conductor extension works with.",
    note: "Threads shown on this page are examples.",
  },
};

export default content;
