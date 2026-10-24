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
    title: "Squeak: your agents, in view",
    description:
      "Squeak watches every Claude Code and Codex session on your Mac, shows which one needs you, and lets you answer from the Mac, an iPhone or Telegram. A menu-bar duck, a Mac app and an iPhone app.",
    canonical,
    ogTitle: "Squeak: your agents, in view",
    ogDescription:
      "Every Claude Code and Codex session on your Mac, ranked by what needs you. Answer from your Mac, your iPhone or Telegram.",
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
    how: "How it works",
    how_href: "#moment",
    mac: "Mac + iPhone",
    mac_href: "#mac",
    download: "Download",
    download_href: "#install",
    logoAlt: "Squeak",
  },

  hero: {
    kicker: "Your local agent desk",
    line1: "Your agents.",
    line2: "In view.",
    lede: "Squeak watches every Claude Code and Codex session on your Mac, shows which one needs you, and lets you answer from the Mac, your iPhone or Telegram.",
    cta: "Download for Mac",
    ctaHref: download,
    secondary: "See an example",
    secondaryHref: "#moment",
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
  },

  sessions: {
    payment: {
      name: "storefront · payment-retries",
      title: "Payment retry logic",
      agent: "claude",
      needs: "claude · needs an answer",
      working: "claude · working",
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

  moment: {
    kicker: "01 / The moment",
    heading: "One needs you. You know which.",
    intro:
      "An illustrative example, one step at a time. The sessions, the question and the choice are made up, and scrolling never sends anything.",
    stateLabel: "Example",
    stepsLabel: "The example in four steps",
    replay: "Replay example",
    panel: {
      listTitle: "Sessions",
      detailLabel: "Session detail",
      stepsTitle: "What it's doing",
    },
    beats: {
      working: {
        step: "01",
        label: "Working",
        title: "Four sessions are working.",
        body: "Nothing is waiting on you, so the duck gets on with its own work too.",
        status: "4 working",
        detail: {
          meta: "storefront · payment-retries",
          state: "claude · working",
          step1: "Read retry.ts",
          step2: "Editing 3 files",
          step3: "Run npm test",
        },
      },
      needs: {
        step: "02",
        label: "Needs you",
        title: "One stops and asks.",
        body: "storefront · payment-retries needs an answer. Squeak moves it to the top and the duck's eyes go wide.",
        status: "1 needs you",
        detail: {
          meta: "storefront · payment-retries",
          state: "claude · needs an answer",
          message:
            "I found the retry path and added an idempotency check. One decision needs your input.",
        },
      },
      choose: {
        step: "03",
        label: "A person chooses",
        title: "You read the question and choose.",
        body: "Claude asks how temporary failures should be retried. Option A is marked as recommended but is never chosen for you. In this example, a person picks A.",
        status: "1 needs you",
        detail: {
          meta: "storefront · payment-retries",
          state: "claude · needs an answer",
          question: "How should temporary failures be retried?",
          optionA: "Retry automatically",
          optionADetail: "Up to 3 attempts with exponential backoff.",
          optionB: "Let the customer retry",
          optionBDetail: "Show a clear error and keep checkout available.",
          recommended: "recommended",
          chosenTag: "A person chooses A",
          demoNote: "Example only. Nothing is sent.",
        },
      },
      sent: {
        step: "04",
        label: "Confirmed",
        title: "Confirmed in the chat, then back to work.",
        body: "Squeak checks that the reply landed before it says so. The agent carries on, and the duck goes back to work.",
        status: "4 working",
        detail: {
          meta: "storefront · payment-retries",
          state: "claude · working",
          receipt: "Reply A confirmed in the Conductor chat",
          step1: "Applying the retry policy",
          step2: "Run npm test -- retry",
        },
      },
    },
  },

  mac: {
    kicker: "02 / Squeak for Mac",
    heading: "The whole picture. One window.",
    lede: "Every session on your Mac, grouped by what it needs from you.",
    viewFull: "View full screenshot",
    viewFullHref: "./assets/mac-decision.webp",
    imageAlt:
      "The Squeak window. A sidebar lists filters and sources. Sessions are grouped as Needs you, Done, Working and Error. The open session, Payment retry logic in storefront · payment-retries, shows the agent's message and the question how temporary failures should be retried, with two answer rows, the first marked recommended, and a reply box.",
    calloutsLabel: "What to notice in the window",
    c1: {
      n: "1",
      title: "What needs you comes first",
      body: "Grouped by need, not by which app they run in.",
    },
    c2: {
      n: "2",
      title: "The agent's own words",
      body: "Its last message in full, one button per option. The recommended one is marked, never pre-selected.",
    },
    c3: {
      n: "3",
      title: "A reply that lands",
      body: "Typed into that chat's own window, then checked before Squeak says it went.",
    },
  },

  duck: {
    kicker: "03 / The duck",
    heading: "Quiet until it matters.",
    lede: "A rubber duck sits in a corner of your screen and in the menu bar. Click it for the list.",
    moodsLabel: "The duck's four moods",
    working: {
      name: "Working",
      body: "A quick bob while any agent is mid-turn.",
      alt: "The duck with a focused look, mid-bob.",
    },
    needs: {
      name: "Needs you",
      body: "Wide eyes and a red badge. Something is blocked until you act.",
      alt: "The duck with wide eyes.",
    },
    done: {
      name: "Done",
      body: "Celebrates for a short while after a turn really ends.",
      alt: "The duck mid-hop, celebrating.",
    },
    asleep: {
      name: "Asleep",
      body: "Nothing running. The duck rests.",
      alt: "The duck asleep with closed eyes.",
    },
  },

  away: {
    kicker: "04 / Away from the desk",
    heading: "Step away. Stay in the loop.",
    lede: "Squeak for iPhone shows the same list and lets you reply. Telegram gets a short card with a button per option.",
    phoneAlt:
      "Squeak for iPhone showing the session squeak · session-hub at work. A What it's doing list shows the latest five of seventeen steps, with a message box at the bottom.",
    phoneCaption: "A working turn, on the phone.",
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
      body: "A phone joins only after you approve it on the Mac.",
    },
    p3: {
      title: "Quiet by default",
      body: "Blocked agents push. A finish pushes only for a Conductor chat.",
    },
    requirement: "Replies go through your Mac, so it needs to be on with Squeak running.",
    link: "Set up the iPhone app",
    linkHref: iphoneSetup,
    linkNote: "Installs through SideStore.",
  },

  trust: {
    kicker: "05 / Trust and compatibility",
    heading: "Your Mac stays in charge.",
    lede: "Answering an agent means pressing keys in another app's window, so Squeak proves each step before it types.",
    t1: {
      title: "Only approved phones",
      body: "A phone joins after you approve it on the Mac.",
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
      summary: "How each check works, and what Squeak can answer",
      d1: {
        title: "The Mac trusts a key, not a server",
        body: "Each phone reply is signed by the paired phone, expires after ten minutes, and can answer only the chat's current question.",
      },
      d2: {
        title: "The agent must be in front",
        body: "Squeak reads which chat is on screen from Conductor's own route, never from a tab label. In Terminal, the agent must own the tab and show its own empty prompt, so text never lands in a shell or over your draft.",
      },
      d3: {
        title: "Confirmed, never retyped",
        body: "A reply that may have gone is checked against the chat's history. If Squeak cannot confirm it, it says so.",
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
    heading: "Keep your agents in view.",
    lede: `Squeak ${version} for Mac, as a disk image. It is free and ad-hoc signed rather than notarized, so macOS asks once before the first launch. After that, Squeak updates itself.`,
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
      body: "Squeak lists your Conductor chats on its own. Answering them also needs the Squeak service running on the Mac.",
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
    note: "Sessions shown on this page are examples.",
  },
};

export default content;
