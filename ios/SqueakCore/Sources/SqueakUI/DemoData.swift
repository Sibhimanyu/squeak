#if os(iOS)
import Foundation
import SqueakCore

/// Launch with `-squeak-demo` to see the app without a Mac: screenshots and design review only.
/// `-squeak-demo-replyable` makes the Payment chat a finished one, so its
/// options and composer are live (a chat waiting inside Conductor cannot be
/// answered from a phone, and the demo keeps to that rule).
enum DemoData {
    /// One answer with every kind of block, for the typesetting captures.
    static let richMessage = """
    ## Session isolation

    Each chat now runs in **its own worktree**, and the check fails loudly if two chats ever share one. I touched `src/fleet/isolation.ts` and the launcher in ~/conductor/repos/squeak.

    Two things are worth knowing:

    - The check runs *before* a chat starts
      - it compares the worktree path with every live chat
      - a clash stops the start and names the chat
    - Archived workspaces are ignored
    - [x] Unit tests for the clash case
    - [ ] A test for a symlinked path

    ### How it behaves

    | Case | Before | Now |
    | :--- | :---: | ---: |
    | Two chats, one worktree | silent clash | **refused** |
    | Archived workspace | counted | ignored |
    | Missing directory | crash | `error` card |

    ```ts
    export function assertIsolated(path: string, live: Chat[]): void {
      const clash = live.find((c) => c.worktree === path);
      if (clash) throw new Error(`worktree held by ${clash.title}`);
    }
    ```

    > Existing chats keep their worktree. The check only guards new starts, so a clash that already exists will not be repaired.

    1. Run `npm test` to see the new cases.
    2. Read [the design doc](https://example.com/docs/isolation) before changing the launcher.

    ---

    Say the word and I will cover the symlink case too.
    """

    private static var replyable: Bool { ProcessInfo.processInfo.arguments.contains("-squeak-demo-replyable") }

    private static func id(_ n: Int) -> String { String(format: "d0000000-0000-4000-8000-%012d", n) }

    /// The chats' own titles (§8.2's headline). "idle" is untitled, so it reads `repo · branch`.
    private static let titles = [
        "pay": "Payment retry logic", "search": "Search index migration", "tg": "Telegram message formatting",
        "link": "Fix onboarding deep link", "cache": "API response caching", "iso": "Session isolation checks",
        "copy": "Checkout copy review", "quota": "Nightly dependency upgrade across every workspace",
    ]

    private static func titled(_ s: PhoneSnapshot.Session) -> PhoneSnapshot.Session {
        var titled = PhoneSnapshot.Session(
            key: s.key, conductorSessionId: s.conductorSessionId, label: s.label, agent: s.agent, state: s.state,
            lastActivityAt: s.lastActivityAt, detail: s.detail, git: s.git, contextPercent: s.contextPercent,
            turnId: s.turnId, message: s.message, choices: s.choices, activity: s.activity, title: titles[s.key],
            question: s.key == "pay" && s.state == "awaiting_input"
                ? (ProcessInfo.processInfo.arguments.contains("-squeak-demo-plan") ? plan : question) : nil,
            failure: s.failure)
        titled.workflow = s.workflow
        // The demo's chats run on the models a real Mac names.
        switch s.key {
        case "pay": titled.model = "Opus 5.5 · 1M"; titled.effort = "Medium"
        case "search": titled.model = "GPT 5.5"; titled.effort = "High"
        case "tg": titled.model = "Opus 5.5 · 1M"; titled.effort = "Extra high"; titled.fast = true
        default: break
        }
        return titled
    }

    /// `-squeak-demo-film`: a RasanAI film waiting on its look call; `-squeak-demo-film-story` on its
    /// story call; `-squeak-demo-film-ask` on a question from the director.
    private static var film: [PhoneSnapshot.Session] {
        let args = ProcessInfo.processInfo.arguments
        guard args.contains(where: { $0.hasPrefix("-squeak-demo-film") }) else { return [] }
        let workflow: Workflow
        if args.contains("-squeak-demo-film-story") {
            workflow = Workflow(
                provider: "rasanai", call: "story", step: "story", revision: "story@1", title: "Quotidian",
                prompt: "Pick a story",
                context: "Every word of the talk is kept in all three; only the worlds around him change.",
                options: [
                    .init(id: "sure", label: "Sure", title: "Lunchbox to glass dome",
                          summary: "Each idea becomes the warm daylight place he stands.",
                          why: "The literal floor: every idea pictured plainly.", image: nil,
                          beats: [.init(name: "b1", seconds: 6, onScreen: "Everyone on the Moon Is Essential Personnel",
                                        line: "I came across an interesting title…")],
                          note: "a world per idea"),
                    .init(id: "bold", label: "Bold", title: "The book he walks through",
                          summary: "He stands inside the pages; each idea is the next spread.",
                          why: "One place that changes, instead of ten.", image: nil, note: "one world, many pages"),
                    .init(id: "wild", label: "Wild", title: "Wheat to bread",
                          summary: "Raw material becomes the finished thing across one cut.",
                          why: "The talk's own image, made the whole film.", image: nil, note: "a single transformation"),
                ],
                recommended: "wild", canAskMore: true)
        } else if args.contains("-squeak-demo-film-animatic") || args.contains("-squeak-demo-film-final") {
            let final = args.contains("-squeak-demo-film-final")
            let scenes: [Workflow.Review.Scene] = [
                .init(id: "b1", title: "The moon colony", line: "I came across an interesting title…", start: 0, seconds: 6.1, thumb: "b1.png"),
                .init(id: "b2", title: "Chapel of cables", line: "Body horror fairytale…", start: 6.1, seconds: 8.8, thumb: "b2.png"),
                .init(id: "b3", title: "The gem inside", line: "Look at this gem I found inside.", start: 14.9, seconds: 5.9, thumb: "b3.png"),
                .init(id: "b4", title: "Wheat, not bread", line: "God made wheat but not bread…", start: 20.8, seconds: 4.6, thumb: "b4.png"),
            ]
            workflow = Workflow(
                provider: "rasanai", call: final ? "final" : "animatic", step: final ? "render" : "animatic",
                revision: "review@1", title: "Quotidian",
                prompt: final ? "Your film. Leave a note on any moment, or render the final." : "Give notes on the animatic",
                review: .init(
                    kind: final ? "final" : "animatic", scenes: scenes,
                    media: .init(kind: final ? "video" : "audio", source: final ? "exports/film.mp4" : "mix.wav", poster: nil),
                    duration: 25.4,
                    notes: [
                        .init(id: "n1", t: 3.5, scene: "b1", x: 0.3, y: 0.2, text: "Hold the title a beat longer", state: "open", resolution: nil),
                        .init(id: "n2", t: 9, scene: "b2", x: nil, y: nil, text: "Warmer light in the chapel", state: "resolved", resolution: "Graded the chapel warmer"),
                    ],
                    finish: final ? ["render", "preview"] : ["approve"], quick: ["Slower", "Faster", "Bigger", "Simpler", "Cut it"]))
        } else if args.contains("-squeak-demo-film-ask") {
            workflow = Workflow(
                provider: "rasanai", call: "ask", step: "brief", revision: "ask:1", title: "Quotidian",
                prompt: "Please move the clip into this project's assets/sources folder",
                ask: .init(id: "1", question: "Please move the clip into this project's assets/sources folder",
                           context: "I can only read files inside the project folder.",
                           options: [.init(id: "added", label: "Done, it's in assets/sources", detail: nil)],
                           recommended: "added", placeholder: "Or type your answer"))
        } else {
            workflow = Workflow(
                provider: "rasanai", call: "look", step: "look", revision: "look@1", title: "Quotidian",
                prompt: "Pick a look",
                options: [
                    .init(id: "sure", label: "Sure", title: "Pop-Up Folio",
                          summary: "A Kelmscott page with one red rubric, papercraft layers and multiplane parallax.",
                          why: "Every title is one of its printed pages rising off a fold above his head.",
                          image: "sure.png"),
                    .init(id: "bold", label: "Bold", title: "Die Line",
                          summary: "Cut lines and fold marks: the film is the template for building it.", why: nil,
                          image: "bold.png"),
                    .init(id: "wild", label: "Wild", title: "Tab A, Slot B",
                          summary: "Flat-pack instructions, numbered parts, one hand assembling.", why: nil,
                          image: "wild.png"),
                ],
                recommended: "wild", canAskMore: true)
        }
        var session = PhoneSnapshot.Session(
            key: "film", conductorSessionId: nil, label: "RasanAI · Quotidian", agent: "claude", state: "awaiting_input",
            lastActivityAt: now(-60), detail: "RasanAI · \(workflow.prompt)", git: nil, contextPercent: nil,
            turnId: nil, message: nil, choices: nil, title: "Quotidian")
        session.workflow = workflow
        return [session]
    }

    /// `-squeak-demo-plan`: the payment chat waits on a plan instead (ExitPlanMode).
    private static let plan = PhoneSnapshot.Question(toolUseId: "toolu_plan", questions: [], plan: """
    ## Retry failed payments safely

    1. Add an idempotency key to every charge request, stored with the order.
    2. Retry temporary failures **three times** with backoff (1s, 4s, 16s).
    3. Show the customer a retry button after the third failure.

    Files: `src/payments/charge.ts`, `src/payments/retry.ts`, and their tests.
    """)

    /// The question the payment chat waits on, as the Mac sends it (an AskUserQuestion, every option).
    private static let question = PhoneSnapshot.Question(toolUseId: "toolu_demo", questions: [
        .init(question: "How should temporary failures be retried?", header: "Retries", multiSelect: false, options: [
            .init(label: "Retry automatically", description: "3 attempts with backoff"),
            .init(label: "Let the customer retry", description: "Keep checkout available"),
        ]),
        .init(question: "Which payment errors count as temporary?", header: "Scope", multiSelect: true, options: [
            .init(label: "Network timeouts", description: nil),
            .init(label: "Rate limits", description: "429 from the provider"),
            .init(label: "Card declines", description: "Usually not worth retrying"),
        ]),
    ])

    static var snapshot: PhoneSnapshot {
        let raw = rawSnapshot
        // -squeak-demo-awake: a timed awake session with 1h 23m left, for screenshots.
        let awake = ProcessInfo.processInfo.arguments.contains("-squeak-demo-awake") ? now(83 * 60 + 30) : nil
        // -squeak-demo-lid: lid closed too and set up; -squeak-demo-lid-failed: it did not turn on;
        // -squeak-demo-safety: a safety rule is acting; -squeak-demo-hotspot: failover is set up.
        let args = ProcessInfo.processInfo.arguments
        let lidFailed = args.contains("-squeak-demo-lid-failed")
        let lid = args.contains("-squeak-demo-lid") || lidFailed
        var demo = PhoneSnapshot(v: raw.v, mac: raw.mac, generatedAt: raw.generatedAt, duck: raw.duck, sessions: args.contains("-squeak-demo-empty-active") ? [] : raw.sessions.map(titled), usage: usage, workspaces: workspaces, recent: recent, keepAwake: awake != nil, awakeUntil: awake,
                             awakeLid: awake != nil && lid ? (lidFailed ? "failed" : "on") : nil,
                             awakeLidProblem: awake != nil && lidFailed ? "Something on this Mac turned sleep back on, so a closed lid would sleep it now." : nil,
                             awakeLidReady: lid ? true : nil,
                             awakeSafety: awake != nil && args.contains("-squeak-demo-safety") ? "Low Power Mode on · Battery at 38%" : nil,
                             macPower: .init(percent: 64, onBattery: true, watts: 12, lidClosed: false),
                             awakeLidActions: .init(displayOff: true, mute: true, lowPower: true, freezeApps: args.contains("-squeak-demo-freeze")),
                             awakeRules: .init(lowPowerPercent: 35, endPercent: 8, heat: true),
                             awakeLastEnd: awake == nil && args.contains("-squeak-demo-ended") ? .init(reason: "battery", at: ISO8601DateFormatter().string(from: Date()), why: "Battery at 9%") : nil)
        if args.contains("-squeak-demo-hotspot") {
            demo.hotspot = .init(configured: true, ssid: "Sibhi's iPhone", enabled: true, onHotspot: false)
        }
        #if DEBUG
        demo.projectIcons = DemoIcons.byProject
        #endif
        demo.chatModels = chatModels
        return demo
    }

    /// Chats from earlier, to pick up again. `-squeak-demo-empty-active` shows them with nothing active.
    private static var recent: [PhoneSnapshot.Session] {
        let ago = { (hours: Double) in ISO8601DateFormatter().string(from: Date().addingTimeInterval(-hours * 3600)) }
        func chat(_ n: Int, _ label: String, _ agent: String, _ state: String, hours: Double, title: String, said: String,
                  open: Bool, failure: String? = nil) -> PhoneSnapshot.Session {
            var s = PhoneSnapshot.Session(
                key: "r\(n)", conductorSessionId: "00000000-0000-0000-0000-0000000000a\(n)", label: label, agent: agent,
                state: state, lastActivityAt: ago(hours), detail: nil, git: nil, contextPercent: nil, turnId: "r\(n)t", message: said,
                choices: nil, title: title, failure: failure)
            s.open = open
            return s
        }
        return [
            chat(1, "storefront · coupon-codes", "claude", "idle", hours: 3, title: "Coupon codes at checkout",
                 said: "Coupons now apply before tax, and the rounding test covers the 0.5 cent case. Want me to add the admin toggle next?", open: true),
            chat(2, "atlas · rate-limits", "codex", "finished", hours: 26, title: "Rate limits per key",
                 said: "Added a token bucket per API key, 60 requests a minute. Nothing else changed.", open: true),
            chat(3, "storefront · refund-flow", "claude", "error", hours: 30, title: "Refund flow",
                 said: "", open: false, failure: "You've hit your session limit · resets 7:20pm"),
            chat(4, "compass · release-notes", "claude", "finished", hours: 52, title: "Release notes for 2.4",
                 said: "Drafted the 2.4 notes from the merged pull requests. Two entries need a screenshot.", open: false),
            chat(5, "squeak · menu-bar-mark", "codex", "idle", hours: 75, title: "Menu bar mark",
                 said: "The template image is 18 points tall and renders crisp on both appearances.", open: true),
            chat(6, "atlas · search-synonyms", "claude", "finished", hours: 120, title: "Search synonyms",
                 said: "Synonyms load from the config file at start. A restart picks up changes.", open: false),
        ]
    }

    /// What the Mac lists for a new chat. `-squeak-demo-no-workspaces` plays a Mac too old to send any.
    private static var workspaces: [PhoneSnapshot.Workspace]? {
        guard !ProcessInfo.processInfo.arguments.contains("-squeak-demo-no-workspaces") else { return nil }
        return [
            .init(id: "w-pay", label: "storefront · payment-retries", defaultAgent: "claude"),
            .init(id: "w-search", label: "atlas · search-migration", defaultAgent: "codex"),
            .init(id: "w-tg", label: "squeak · telegram-formatting", defaultAgent: "claude"),
            .init(id: "w-link", label: "compass · onboarding-link", defaultAgent: "codex"),
            .init(id: "w-cache", label: "atlas · api-caching", defaultAgent: "claude"),
        ]
    }

    /// Claude's reading is a few hours old, as it would be unless Refresh was pressed on the Mac.
    private static var usage: PhoneSnapshot.Usage {
        .init(
            claude: .init(fiveHour: .init(usedPercent: 42, resetsAt: now(2 * 3600 + 10 * 60)),
                          sevenDay: .init(usedPercent: 18, resetsAt: now(4 * 86400 + 5 * 3600)), observedAt: now(-3 * 3600)),
            codex: .init(fiveHour: .init(usedPercent: 9, resetsAt: now(3 * 3600 + 40 * 60)),
                         weekly: .init(usedPercent: 31, resetsAt: now(5 * 86400)), observedAt: now(-30)))
    }

    private static var rawSnapshot: PhoneSnapshot {
        PhoneSnapshot(
            v: 1, mac: "Sibhi's MacBook", generatedAt: now(-4),
            duck: .init(blockedCount: 2, workingCount: 3),
            sessions: film + [
                .init(key: "pay", conductorSessionId: id(1), label: "storefront · payment-retries", agent: "claude",
                      state: replyable ? "finished" : "awaiting_input",
                      lastActivityAt: now(-120), detail: "How should temporary failures be retried?", git: "+84/−12 · 3 files", contextPercent: 41,
                      turnId: "t1",
                      message: "I added an idempotency check. One decision needs your input.\n\n**How should temporary failures be retried?**\n\n**A) Retry automatically.** 3 attempts with backoff.\n\n**B) Let the customer retry.** Keep checkout available.\n\nBoth prevent duplicate charges.",
                      choices: .init(question: "How should temporary failures be retried?",
                                     options: [.init(letter: "A", title: "Retry automatically — 3 attempts with backoff."),
                                               .init(letter: "B", title: "Let the customer retry — Keep checkout available.")],
                                     recommended: "A")),
                .init(key: "search", conductorSessionId: id(2), label: "atlas · search-migration", agent: "codex", state: "awaiting_approval",
                      lastActivityAt: now(-300), detail: "Codex needs your permission to run a command", git: nil, contextPercent: nil,
                      turnId: nil, message: "Codex needs your permission to run a command", choices: nil),
                .init(key: "tg", conductorSessionId: id(3), label: "squeak · telegram-formatting", agent: "claude", state: "working",
                      lastActivityAt: now(-720), detail: "Running tests", git: "+311/−10 · 20 files", contextPercent: nil,
                      turnId: "t2", message: nil, choices: nil,
                      activity: .init(total: 17, steps: [
                          .init(kind: "note", text: "Checking why bold text arrives as literal asterisks."),
                          .init(kind: "tool", text: "Read src/utils/tg-format.ts"),
                          .init(kind: "thinking", text: "The splitter cuts inside an open tag, so the retry falls back to plain text."),
                          .init(kind: "tool", text: "Edit src/utils/tg-format.ts"),
                          .init(kind: "tool", text: "Run npm test -- tg-format"),
                      ])),
                .init(key: "link", conductorSessionId: id(4), label: "compass · onboarding-link", agent: "codex", state: "working",
                      lastActivityAt: now(-1080), detail: "Editing 2 files", git: nil, contextPercent: 74,
                      turnId: "t3", message: nil, choices: nil,
                      activity: .init(total: 6, steps: [.init(kind: "tool", text: "Edit DeepLinkRouter.swift"), .init(kind: "tool", text: "Edit OnboardingView.swift")])),
                .init(key: "cache", conductorSessionId: id(5), label: "atlas · api-caching", agent: "claude", state: "working",
                      lastActivityAt: now(-1620), detail: "Reading code", git: nil, contextPercent: nil,
                      turnId: "t4", message: nil, choices: nil,
                      activity: .init(total: 3, steps: [.init(kind: "tool", text: "Read src/api/cache.ts")])),
                .init(key: "iso", conductorSessionId: id(6), label: "squeak · session-isolation", agent: "claude", state: "finished",
                      lastActivityAt: now(-3600), detail: "Each session now runs in its own worktree.", git: "+42/−3 · 2 files", contextPercent: nil,
                      turnId: "t5", message: ProcessInfo.processInfo.arguments.contains("-squeak-demo-tail") ? String(richMessage[richMessage.range(of: "```ts")!.lowerBound...]) : richMessage, choices: nil),
                .init(key: "copy", conductorSessionId: id(7), label: "storefront · checkout-copy", agent: "codex", state: "finished",
                      lastActivityAt: now(-7200), detail: "Reviewed the checkout copy.", git: nil, contextPercent: nil,
                      turnId: "t6", message: "Reviewed the checkout copy. Three strings were tightened.\n\n![Checkout, before and after](</Users/demo/conductor/workspaces/storefront/oslo/.context/checkout.png>)\n\nThe button now says what it does.", choices: nil),
                .init(key: "idle", conductorSessionId: id(8), label: "compass · release-notes", agent: "claude", state: "idle",
                      lastActivityAt: now(-10800), detail: nil, git: nil, contextPercent: nil,
                      turnId: nil, message: nil, choices: nil),
            ] + (ProcessInfo.processInfo.arguments.contains("-squeak-demo-error") ? [
                // `-squeak-demo-error`: a chat whose turn failed, with the reason the Mac sends.
                .init(key: "quota", conductorSessionId: id(9), label: "squeak · deps-upgrade", agent: "claude", state: "error",
                      lastActivityAt: now(-540), detail: nil, git: nil, contextPercent: nil,
                      turnId: "t7", message: "Upgrading the lockfile first.", choices: nil,
                      failure: "You've hit your session limit · resets 7:20pm (Asia/Calcutta)"),
            ] : []))
    }

    /// A reply already sent from this phone, so the demo shows a "You" bubble.
    static var outbox: [String: [AppModel.SentMessage]] {
        ["pay": [.init(text: "Add retry handling for failed payments.\nPrevent duplicate charges.", date: Date().addingTimeInterval(-300), answersTurn: "t0")],
         // The working chat: what started the turn, a steer that landed inside it, and one queued behind it.
         "tg": [.init(text: ProcessInfo.processInfo.arguments.contains("-squeak-demo-photos")
                      ? PhotoAttachment.compose("Fix the splitter, and make sure tables still render. Like this screenshot.",
                                                refs: [".context/attachments/ab12cd34/image-1.jpg", ".context/attachments/ef56ab78/image-1.png"])
                      : "Fix the splitter, and make sure tables still render.", date: Date().addingTimeInterval(-700), answersTurn: "t1", status: .sent),
                .init(text: "Keep the plain-text fallback for anything it still can't parse.", date: Date().addingTimeInterval(-240), answersTurn: "t1",
                      status: .steered, mode: .steer),
                .init(text: "Then update the README's formatting section.", date: Date().addingTimeInterval(-60), answersTurn: "t1",
                      status: .queued(agent: "Claude", steerUnavailable: false), messageId: demoQueued, mode: .queue, queuedBehindTurn: true)]]
    }

    private static let demoQueued = "0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31"

    /// The working chat's turn as the Mac streams it: whole steps, the steer where it landed, and
    /// Conductor's queue (one from this phone, one typed on the Mac).
    /// Conductor's model picker as the Mac lists it: favourites first, then the rest.
    private static var chatModels: [PhoneSnapshot.ChatModel] {
        let claude = ["low", "medium", "high", "xhigh", "max"]
        let codex = ["low", "medium", "high", "xhigh"]
        return [
            .init(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: claude, defaultLevel: "medium", favorite: true),
            .init(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: claude, defaultLevel: "medium", favorite: true),
            .init(id: "gpt-5.6-terra", agent: "codex", label: "GPT 5.6 Terra", levels: codex, defaultLevel: "medium", favorite: true),
            .init(id: "gpt-6.1-sol", agent: "codex", label: "GPT 6.1 Sol", levels: codex, defaultLevel: "high", favorite: true),
            .init(id: "opus-5-1m", agent: "claude", label: "Opus 5 · 1M", levels: claude, defaultLevel: "medium"),
            .init(id: "fable-5-1", agent: "claude", label: "Fable 5.1", levels: claude, defaultLevel: "medium"),
            .init(id: "haiku-4-5", agent: "claude", label: "Haiku 4.5", levels: []),
            .init(id: "gpt-5.5", agent: "codex", label: "GPT 5.5", levels: codex, defaultLevel: "high"),
        ]
    }

    /// `-squeak-demo-long`: a long chat above the turn, to see the chat open at its newest message.
    private static var longHistory: [LiveTurn.HistoryEntry] {
        guard ProcessInfo.processInfo.arguments.contains("-squeak-demo-long") else { return [] }
        var entries: [LiveTurn.HistoryEntry] = []
        for i in 0..<14 {
            let ask = "Question \(i + 1): what does the splitter do with a table that is longer than one message?"
            let answer = "Answer \(i + 1): it splits on block boundaries first, so a table stays whole when it fits, and falls back to rows when it does not."
            let seconds: Double = Double(5000 - i * 200)
            entries.append(LiveTurn.HistoryEntry(role: "user", text: ask, at: now(-seconds)))
            entries.append(LiveTurn.HistoryEntry(role: "assistant", text: answer, at: now(-(seconds - 100)), workBefore: i % 3 == 0 ? 4 : nil))
        }
        return entries
    }

    static var liveTurns: [String: LiveTurn] {
        ["tg": LiveTurn(key: "tg", working: true, total: 7, steps: [
            .init(kind: "note", text: "Checking why bold text arrives as literal asterisks."),
            .init(kind: "tool", text: "Read src/utils/tg-format.ts"),
            .init(kind: "thinking", text: "The splitter cuts inside an open tag, so Telegram rejects the markup and the retry falls back to plain text. Splitting on block boundaries first, then on tags, keeps every chunk balanced."),
            .init(kind: "you", text: "Keep the plain-text fallback for anything it still can't parse."),
            .init(kind: "thinking", text: "Keeping the fallback: it only runs when Telegram rejects a chunk."),
            .init(kind: "tool", text: "Edit src/utils/tg-format.ts"),
            .init(kind: "tool", text: "Run npm test -- tg-format"),
        ], queue: [
            .init(id: demoQueued, text: "Then update the README's formatting section.", mode: "queue", position: 0),
            .init(id: "6b1d0c7e-8a43-4f0e-b2d9-1c5e7a9f3d20", text: "Run the whole suite before you finish.", mode: "queue", position: 1),
        ], history: longHistory + [
            .init(role: "user", text: "Telegram shows ** and ## literally in long answers. Find out why.", at: now(-1500)),
            .init(role: "assistant", text: "The splitter cuts messages inside an open tag, so Telegram rejects the markup and the retry falls back to plain text. I can fix the splitter and keep the fallback.", at: now(-900), workBefore: 6),
            .init(role: "user", text: ProcessInfo.processInfo.arguments.contains("-squeak-demo-photos")
                  ? PhotoAttachment.compose("Fix the splitter, and make sure tables still render. Like this screenshot.",
                                            refs: [".context/attachments/ab12cd34/image-1.jpg", ".context/attachments/ef56ab78/image-1.png"])
                  : "Fix the splitter, and make sure tables still render.", at: now(-700)),
        ])]
    }

    static let diff = WorkspaceDiff(baseRef: "origin/main", files: [
        .init(path: "src/utils/tg-format.ts", insertions: 64, deletions: 12, binary: false, untracked: false),
        .init(path: "src/utils/tg-format.test.ts", insertions: 41, deletions: 0, binary: false, untracked: true),
        .init(path: "docs/telegram.md", insertions: 6, deletions: 2, binary: false, untracked: false),
    ], insertions: 111, deletions: 14, truncated: false)

    static func patch(for index: Int) -> FilePatch {
        FilePatch(index: index, path: diff.files[index].path, text: """
        @@ -41,9 +41,14 @@ export function splitMarkdown(text: string, limit = 4096): string[] {
           const chunks: string[] = [];
        -  let current = "";
        +  // Split on block boundaries first, so a chunk never ends inside an open tag.
        +  const blocks = text.split(/\\n{2,}/);
        +  let current = "";
           for (const block of blocks) {
        -    if (current.length + block.length > limit) chunks.push(current);
        +    if (current.length + block.length + 2 > limit) {
        +      chunks.push(current.trimEnd());
        +      current = "";
        +    }
             current += block + "\\n\\n";
           }
        """)
    }

    /// `-squeak-stream`: the working chat keeps adding steps, for profiling a streamed turn.
    static let streamSteps: [LiveTurn.Step] = [
        .init(kind: "thinking", text: "Two tests fail on nested lists; the tag stack needs to survive a chunk boundary."),
        .init(kind: "tool", text: "Edit src/utils/tg-format.ts"),
        .init(kind: "tool", text: "Run npm test -- tg-format"),
        .init(kind: "note", text: "Nested lists pass now. Checking tables."),
        .init(kind: "tool", text: "Read src/utils/tg-format.test.ts"),
        .init(kind: "tool", text: "Edit src/utils/tg-format.test.ts"),
    ]

    /// The agent's previous answer in the working chat, kept above its working row.
    static var remembered: [String: RememberedMessage] {
        ["tg": RememberedMessage(
            text: "The splitter cuts messages inside an open tag, so Telegram rejects the markup and the retry falls back to plain text. I can fix the splitter and keep the fallback.",
            atISO: now(-900), turnId: "t1")]
    }

    private static func now(_ offset: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date().addingTimeInterval(offset))
    }
}
#endif
