// All copy and links for the Squeak page. Plain values only: the build
// escapes every token, so nothing here may contain markup.
// Release facts (version, file, URL, minimum macOS) come from release.json,
// which the release tooling keeps in step with the published appcast.

import release from "../release.json";

const version: string = release.version;
const dmg: string = release.fileName;
const download: string = release.downloadUrl;
const minMacOS = `macOS ${String(release.minimumSystemVersion).split(".")[0]} or later`;
const canonical = "https://sibhimanyu.github.io/squeak/";
const releases = "https://github.com/Sibhimanyu/squeak/releases/latest";
const iphoneSetup = "https://squeak-5c9gvo.web.app/";
const moreProjects = "https://sibhimanyu.github.io/";

const content = {
  site: {
    lang: "en",
    title: "Squeak: your Conductor chats, in view",
    description:
      "Squeak brings Conductor chats to a Mac attention inbox, with replies in Conductor, iPhone, web browser, Telegram or Zoho Cliq. It can also watch Claude Code and Codex sessions, with replies supported in Apple's Terminal.",
    canonical,
    ogTitle: "Squeak: your Conductor chats, in view",
    ogDescription:
      "Your Conductor chats, ranked by what needs you. Reply from your Mac, iPhone, a web browser, Telegram or Zoho Cliq.",
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
    calls: "Phone calls",
    calls_href: "#calls",
    conductor: "Conductor",
    conductor_href: "#conductor",
    mac: "Mobile + web",
    mac_href: "#away",
    download: "Download",
    download_href: "#install",
    logoAlt: "Squeak",
  },

  hero: {
    kicker: "Your Conductor attention inbox",
    line1: "Your agents.",
    line2: "In view.",
    lede: "See every Conductor chat in one attention-first inbox. Read the question, reply or steer the work, then keep up from your Mac, iPhone, Squeak for Web, Telegram or Zoho Cliq.",
    cta: "Download for Mac",
    ctaHref: download,
    secondary: "Explore Conductor features",
    secondaryHref: "#conductor",
    meta: `Version ${version} · ${minMacOS} · Apple silicon · Free`,
    duckAlt:
      "Squeak's mascot, a yellow rubber duck with an orange bill, looking to the right.",
    previewLabel: "Squeak window, example sessions",
    previewTitle: "Sessions",
    previewStatus: "1 needs you",
    previewNote: "Example sessions",
    signalLabel: "Right now",
    signalValue: "01",
    signalNote: "needs your input",
    stageDescription:
      "Decoration: a pile of Squeak's rubber duck mascot drops into view and settles beside an example Squeak window. Moving a pointer over it nudges the ducks.",
  },

  conductor: {
    kicker: "01 / Made for Conductor",
    heading: "Your Conductor chats, with you wherever you work.",
    lede: "Squeak is an independent companion to Conductor. It reads your chats into one attention-first inbox, puts questions and approvals up front, and sends your reply back to the right conversation.",
    mark: "Built for Conductor",
    markAlt: "Conductor",
    markHref: "https://www.conductor.build/",
    p1: { title: "See the whole queue", body: "Find chats that need you, are working, finished or hit an error, with the latest activity and message." },
    p2: { title: "Reply in the same chat", body: "Answer a choice or write your own message. Squeak checks that the reply reached Conductor before showing it as sent." },
    p3: { title: "Start and steer work", body: "Create a Conductor chat, queue a message for later, or steer a message into a running turn. Model and thinking controls stay in sync with Conductor." },
    thanks: "With personal thanks to",
    person: "Charlie Holtz",
    personHref: "https://x.com/charlieholtz",
    thanksBody: "for building Conductor. Squeak is made independently by Sibhimanyu.",
  },

  sessions: {
    payment: {
      name: "storefront · payment-retries",
      title: "Payment retry logic",
      agent: "claude",
      needs: "claude · needs an answer",
      working: "claude · working",
      done: "claude · done",
      age: "2m",
    },
    atlas: {
      name: "atlas · search-index",
      agent: "codex",
      working: "codex · working",
      age: "just now",
    },
    compass: {
      name: "compass · onboarding-link",
      agent: "codex",
      working: "codex · editing 2 files",
      age: "18m",
    },
    squeak: {
      name: "squeak · telegram-formatting",
      agent: "claude",
      working: "claude · running tests",
      age: "12m",
    },
  },

  mac: {
    kicker: "02 / Squeak for Mac",
    heading: "The whole picture. One window.",
    lede: "See sessions grouped by what they need from you: questions and approvals, finished work, active work, errors and idle sessions. Squeak also watches Claude Code and Codex sessions in supported local apps.",
    viewFull: "View full screenshot",
    viewFullHref: "./assets/mac-decision.webp",
    imageAlt:
      "The Squeak window. A sidebar lists filters and sources. Sessions are grouped as Needs you, Done, Working and Error. The open session, Payment retry logic in storefront · payment-retries, shows the agent's message and the question how temporary failures should be retried, with two answer rows, the first marked recommended, and a reply box.",
    activityAlt:
      "A second Squeak window behind the first, showing another session, squeak · telegram-formatting, with a finished answer and a reply box.",
    calloutsLabel: "What to notice in the window",
    c1: {
      n: "1",
      title: "What needs you comes first",
      body: "Sessions are grouped by state, across Conductor and supported local agent sessions.",
    },
    c2: {
      n: "2",
      title: "The agent's own words",
      body: "The latest message and parsed choices. A recommendation is marked, never pre-selected.",
    },
    c3: {
      n: "3",
      title: "Replies go to the right chat",
      body: "The reply box routes your answer to this Conductor chat.",
    },
  },

  away: {
    kicker: "03 / Away from the desk",
    heading: "Step away. Stay in the loop.",
    lede: "Pair an iPhone or use Squeak for Web in any browser to see your chats and reply while away. Telegram and Zoho Cliq can send cards and take replies too. Replies travel through Squeak on your Mac, which needs to be awake and running.",
    phoneAlt:
      "Squeak for iPhone showing Projects with eight sessions across workspaces, including a project with an approval request and a working session. Home, Sessions, Needs you, and Settings tabs appear at the bottom.",
    phoneCaption: "Your projects and sessions at a glance on iPhone.",
    telegramLabel: "A Telegram card for the example session",
    telegram: {
      from: "Squeak",
      title: "storefront · payment-retries",
      state: "needs an answer",
      question: "How should temporary failures be retried?",
      changed: "3 files changed",
      buttonA: "★ A",
      buttonB: "B",
      buttonReply: "Reply",
      buttonFull: "Full message",
      caption: "Telegram card, example session",
    },
    p1: {
      title: "Paired on your Mac",
      body: "A phone joins only after you approve it on the Mac. The iPhone app syncs through a Firebase project you create; free SideStore installs do not receive push notifications.",
    },
    requirement: "Replies go through your Mac, so it needs to be on with Squeak running.",
    link: "Set up the iPhone app",
    linkHref: iphoneSetup,
    linkNote: "Installs through SideStore, or",
    webLink: "open Squeak for Web—no install needed.",
    webHref: "https://squeak-mac.web.app/",
  },

  calls: {
    kicker: "Optional / Phone calls",
    heading: "A call when a chat is waiting. A way back in, too.",
    lede: "Connect Squeak to a SIP phone system when you want an audible prompt away from your screen. Calling is optional and requires a configured PBX connection.",
    outbound: {
      label: "Squeak calls you",
      title: "Hear the question. Answer by keypad.",
      body: "For a waiting question or approval, Squeak can call your configured extension, read the prompt aloud and accept a keypad choice. An approval itself still needs your confirmation in the Mac or iPhone app.",
    },
    inbound: {
      label: "You call Squeak",
      title: "Dictate a message into a chat.",
      body: "Call Squeak’s extension, choose an available chat and dictate a message. Your Mac transcribes the recording locally, reads it back for confirmation, then sends it if the chat can still take a message.",
    },
    setup: "Setup options: a direct SIP extension on your network or VPN, or a Home Assistant voice gateway for a Mac and PBX on separate networks. Configure SIP credentials and extensions yourself. Answering a call requires a PIN; calling in to dictate also needs Whisper and ffmpeg on the Mac.",
    docs: "Calling setup and requirements",
    docsHref: "https://github.com/Sibhimanyu/squeak/blob/main/docs/voice.md",
  },

  trust: {
    kicker: "05 / Supported sessions and privacy",
    heading: "Your Mac stays in charge.",
    lede: "Squeak can reply to Conductor chats through its relay. For Claude Code or Codex in Apple's Terminal, it types only when the right agent tab is active and ready. Other integrations are for monitoring.",
    t1: {
      title: "Only approved devices",
      body: "A phone or browser joins after you approve it on the Mac.",
    },
    t2: {
      title: "The right session",
      body: "Squeak checks which chat or tab is in front before it types.",
    },
    t3: {
      title: "Delivery is checked",
      body: "A reply is confirmed in the chat, and never sent twice.",
    },
    more: {
      summary: "How reply checks work and which sessions support replies",
      d1: {
        title: "The Mac trusts a key, not a server",
        body: "Each paired device signs its replies. They expire after ten minutes and can answer only the chat's current question.",
      },
      d2: {
        title: "The agent must be in front",
        body: "Squeak identifies the target Conductor chat before sending. In Terminal, the supported Claude Code or Codex process must own the tab and show its empty prompt, so text does not land in a shell or over your draft.",
      },
      d3: {
        title: "Confirmed, never retyped",
        body: "A reply that may have gone is checked against the chat history. If Squeak cannot confirm delivery, it says so instead of retrying blindly.",
      },
    },
    table: {
      caption: "What Squeak can see and answer",
      colTool: "Where the agent runs",
      colWatch: "Watches",
      colReply: "Replies",
      r1: {
        tool: "Conductor chats",
        watch: "Yes",
        reply: "Yes",
        note: "Typed into Conductor's own window.",
      },
      r2: {
        tool: "claude or codex in Apple's Terminal",
        watch: "Yes",
        reply: "Yes",
        note: "Typed into the agent's own tab.",
      },
      r3: {
        tool: "Other local terminals",
        watch: "Yes",
        reply: "Watch only",
        note: "Replies work only in Apple's Terminal.",
      },
      r4: {
        tool: "Claude Desktop: Code and Cowork",
        watch: "Yes",
        reply: "Watch only",
        note: "Cowork cannot report an approval prompt.",
      },
      r5: {
        tool: "Codex app",
        watch: "Yes",
        reply: "Watch only",
        note: "",
      },
    },
  },

  install: {
    kicker: "06 / Install",
    heading: "Keep Conductor close.",
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
      title: "Find it in the menu bar",
      body: "Squeak connects to Conductor and lists your chats. Replies from any device go through the Squeak service on your Mac, which must be awake and running.",
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
    webHref: "https://squeak-mac.web.app/",
    note: "Sessions shown on this page are examples.",
  },
};

export default content;
