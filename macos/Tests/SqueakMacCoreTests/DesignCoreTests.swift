import Foundation
import Testing
@testable import SqueakMacCore

private let decision = [
    "```", "DEBUG REPORT", "A) this line is inside a code block and must be ignored", "```", "",
    "**D1 — Arm device control on the farm?** (reply with a letter)", "",
    "The dashboard can't operate anything until `allow_control` is flipped to true on the add-on.", "",
    "Recommendation: A, because you have asked twice for working light control.", "",
    "**A) Arm it now (recommended).** Completeness: 10/10. I set `allow_control: true`, restart the add-on.", "",
    "**B) Arm it, but only after you are physically near the hardware.** Completeness: 8/10. Same change, later.", "",
    "**C) Leave it off.** Completeness: 3/10. The dashboard now says plainly that control is switched off.", "",
    "Net: the code is ready and the failure mode is now honest.",
].joined(separator: "\n")

@Suite("Choices")
struct ChoicesTests {
    @Test func realDecisionMessage() {
        let p = Choices.parseFull(decision)
        #expect(p?.question == "D1 — Arm device control on the farm?")
        #expect(p?.options == [
            Choice(letter: "A", label: "Arm it now"),
            Choice(letter: "B", label: "Arm it, but only after you are physically near the hardware"),
            Choice(letter: "C", label: "Leave it off"),
        ])
        #expect(p?.recommended == "A")
    }

    @Test func firstSentenceWhenNotBold() {
        let p = Choices.parseFull("Which one?\n\nA) Ship it. It is ready.\nB. Wait a day — CI is flaky.\n")
        #expect(p?.options == [Choice(letter: "A", label: "Ship it"), Choice(letter: "B", label: "Wait a day")])
        #expect(p?.question == "Which one?")
        #expect(p?.recommended == nil)
    }

    @Test func listMarkersAndParens() {
        #expect(Choices.parse("- (A) Keep\n- (B) Drop\n").map(\.letter) == ["A", "B"])
    }

    @Test func ordinaryFinishMessages() {
        #expect(Choices.parse("Done. All tests pass and the branch is pushed.").isEmpty)
        #expect(Choices.parse("1. Ran the tests\n2. Fixed the import\n").isEmpty)
        #expect(Choices.parse("").isEmpty)
        #expect(Choices.parseFull(nil) == nil)
    }

    @Test func needsTwoStartingAtA() {
        #expect(Choices.parse("A) The only option").isEmpty)
        #expect(Choices.parse("B) Second\nC) Third").isEmpty)
    }

    @Test func sentenceStartingWithA() {
        #expect(Choices.parse("A small fix landed.\nB is next.").isEmpty)
    }

    @Test func twoBlocksAreAmbiguous() {
        #expect(Choices.parse("D1?\nA) one\nB) two\n\nD2?\nA) three\nB) four").isEmpty)
    }

    @Test func recommendationMustBeOffered() {
        #expect(Choices.parseFull("Recommendation: D\nA) one\nB) two")?.recommended == nil)
    }
}

@Suite("ShortRelativeTime")
struct ShortRelativeTimeTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    @Test func buckets() {
        func f(_ s: TimeInterval) -> String { ShortRelativeTime.format(now.addingTimeInterval(-s), now: now) }
        #expect(f(0) == "now")
        #expect(f(59) == "now")
        #expect(f(60) == "1m")
        #expect(f(120) == "2m")
        #expect(f(3599) == "59m")
        #expect(f(3600) == "1h")
        #expect(f(86399) == "23h")
        #expect(f(86400 * 3) == "3d")
        #expect(f(86400 * 14) == "2w")
        #expect(ShortRelativeTime.format(now.addingTimeInterval(30), now: now) == "now")
        #expect(f(86400 * 120).contains(" "))
    }
}

@Suite("SessionGrouping")
struct SessionGroupingTests {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    func s(_ id: String, _ st: SessionState, ago: TimeInterval?, alive: Bool? = nil) -> HostSession {
        HostSession(key: SessionKey(provider: "t", hostSessionId: id), title: id, state: st,
                    lastActivityAt: ago.map { now.addingTimeInterval(-$0) }, alive: alive)
    }

    @Test func sectionsAndOrder() {
        let all = [
            s("old", .finished, ago: 86400 * 3), s("rec", .finished, ago: 7200), s("idle", .idle, ago: 600),
            s("w1", .working, ago: 60), s("w2", .working, ago: 10), s("b", .blocked, ago: 5),
            s("dead", .working, ago: 100, alive: false), s("none", .idle, ago: nil),
            s("err", .error, ago: 300), s("olderr", .error, ago: 86400 * 2),
        ]
        let pinned = Set([all[3].key])  // w1
        let g = SessionGrouping.group(all, pinned: pinned, now: now)
        // Attention order: needs you, done, working, error, idle.
        #expect(g.map(\.kind) == [.needsYou, .done, .working, .error, .idle])
        #expect(g[0].sessions.map(\.title) == ["b"])
        #expect(g[1].sessions.map(\.title) == ["rec"])
        #expect(g[2].sessions.map(\.title) == ["w1", "w2"])  // pinned first
        #expect(g[3].sessions.map(\.title) == ["err"])
        #expect(g[4].sessions.map(\.title) == ["dead", "idle", "olderr", "old", "none"])
    }

    @Test func rowsInsideASectionAreNewestFirstEvenWhenAnOlderOneNeedsYou() {
        let g = SessionGrouping.group([s("older-blocked", .blocked, ago: 600), s("newer-blocked", .blocked, ago: 5),
                                       s("w-old", .working, ago: 900), s("w-new", .working, ago: 3)], now: now)
        #expect(g[0].sessions.map(\.title) == ["newer-blocked", "older-blocked"])
        #expect(g[1].sessions.map(\.title) == ["w-new", "w-old"])
        // Search lists the newest chat first among equal matches.
        let hits = SearchIndex(sessions: [s("fix a", .idle, ago: 900), s("fix b", .idle, ago: 5)], messages: [:]).search("fix")
        #expect(hits.map(\.key.hostSessionId) == ["fix b", "fix a"])
    }

    @Test func staleFinishesFallToIdleAndAreEarlier() {
        let old = s("old", .finished, ago: 86400 * 3)
        #expect(SessionGrouping.kind(of: old, now: now) == .idle)
        #expect(SessionGrouping.isEarlier(old, now: now))
        #expect(!SessionGrouping.isEarlier(s("i", .idle, ago: 600), now: now))
        #expect(!SessionGrouping.isEarlier(s("w", .working, ago: 1), now: now))
    }

    @Test func emptySectionsHidden() {
        let g = SessionGrouping.group([s("w", .working, ago: 1)], now: now)
        #expect(g.map(\.kind) == [.working])
    }
}

@Suite("Answer cards and live phrases")
struct AnswerCardTests {
    @Test func splitsTitleDescriptionAndRecommendation() {
        let text = "Found it.\n\nHow should failures be retried?\n\nA. Retry automatically — Up to 3 attempts. (Recommended)\nB. **Let the customer retry** — Show an error.\n\nBoth are safe."
        let l = ChoiceLayout.make(text)
        #expect(l?.question == "How should failures be retried?")
        #expect(l?.before == "Found it.")
        #expect(l?.after == "Both are safe.")
        #expect(l?.cards.map(\.title) == ["Retry automatically", "Let the customer retry"])
        #expect(l?.cards.map(\.detail) == ["Up to 3 attempts.", "Show an error."])
        #expect(l?.cards.map(\.isRecommended) == [true, false])
    }

    @Test func noOptionsNoLayout() {
        #expect(ChoiceLayout.make("Just prose, no options.") == nil)
    }

    @Test func phrasesFromSteps() {
        #expect(ActivityPhrase.short([]) == "Working")
        #expect(ActivityPhrase.short([ActivityStep(kind: "tool", text: "Run npm test -- x")]) == "Running tests")
        #expect(ActivityPhrase.short([ActivityStep(kind: "tool", text: "Read a.ts")]) == "Reading code")
        let edits = [ActivityStep(kind: "tool", text: "Edit a.ts"), ActivityStep(kind: "tool", text: "Edit b.ts")]
        #expect(ActivityPhrase.short(edits) == "Editing 2 files")
    }

    @Test func sources() {
        #expect(SessionSource(provider: "conductor") == .conductor)
        #expect(SessionSource(provider: "codex-terminal") == .terminal)
        #expect(SessionSource(provider: "claude-desktop") == .claudeDesktop)
        #expect(SessionSource(provider: "codex-desktop") == .codexApp)
    }
}

@Suite struct DesignTokenTests {
    @Test func brandAndStateTokensMirrorDesignMd() {
        #expect(Tokens.duck == 0xFFDA1A)
        #expect(Tokens.duckWing == 0xFFC812)
        #expect(Tokens.beak == 0xFF972E)
        #expect(Tokens.duckOutline == 0x18191B)
        #expect(Tokens.duckText == 0x8A5A00)
        #expect([Tokens.Dark.needsYou, Tokens.Dark.working, Tokens.Dark.done, Tokens.Dark.error, Tokens.Dark.idle, Tokens.Dark.offline]
            == [0xF87171, 0x22C55E, 0x38BDF8, 0xA78BFA, 0x71717A, 0x52525B])
        #expect([Tokens.Light.needsYou, Tokens.Light.working, Tokens.Light.done, Tokens.Light.error, Tokens.Light.idle, Tokens.Light.offline]
            == [0xDC2626, 0x15803D, 0x0369A1, 0x7C3AED, 0x71717A, 0xA1A1AA])
        #expect(Tokens.Dark.surfaceRaised == 0x27272A && Tokens.Light.surfaceRaised == 0xFFFFFF)
        #expect(Tokens.Dark.sidebar == 0x0E0E11 && Tokens.Light.sidebar == 0xEBEBEC)
    }
}

@Suite struct RowLineTests {
    @Test func liveStepIsLowercaseAndNeverInvented() {
        #expect(ActivityPhrase.rowLine([]) == nil)
        #expect(ActivityPhrase.rowLine([ActivityStep(kind: "tool", text: "Run npm test -- x")]) == "running tests")
        #expect(ActivityPhrase.rowLine([ActivityStep(kind: "tool", text: "Mystery tool")]) == nil)
        let edits = [ActivityStep(kind: "tool", text: "Edit a.ts"), ActivityStep(kind: "tool", text: "Edit b.ts")]
        #expect(ActivityPhrase.rowLine(edits) == "editing 2 files")
    }
}
