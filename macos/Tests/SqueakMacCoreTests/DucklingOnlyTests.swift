import XCTest
@testable import SqueakMacCore

/// A chat shows Working only while Claude itself works. While only a duckling works (Claude waits on a foreground one,
/// or its turn ended and ducklings remain) the ducklings bar shows the work and the chat reads as ready with ducklings
/// at work. The fixtures are two real chats of the owner's, captured from the session host (titles and step labels only).
final class DucklingOnlyTests: XCTestCase {
    private func fixture(_ name: String) throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "native"))
        return try Data(contentsOf: url)
    }

    private func load(_ name: String) throws -> (host: HostSession, timeline: TurnTimeline, events: [TimelineEvent]) {
        let row = try JSONDecoder().decode(NativeSession.self, from: try fixture("\(name)-session"))
        let page = try JSONDecoder().decode(TimelinePage.self, from: try fixture("\(name)-timeline"))
        var t = TurnTimeline()
        t.load(page.events, hasEarlier: page.hasEarlier)
        return (NativeAdapter.map(row, overlay: nil), t, page.events)
    }

    private let now = Log.t0.addingTimeInterval(10_000)
    private func surface(_ t: TurnTimeline, _ host: HostSession) -> DucklingSurface {
        DucklingSurface.make(timeline: t, host: host, agent: "Claude", model: "Opus 5.5", now: now)
    }

    // MARK: The real chat that waits on a foreground duckling

    func testForegroundDucklingChatShowsNoWorkingRowAndAStopOnTheBar() throws {
        let (host, t, _) = try load("duckling-only-foreground")
        XCTAssertEqual(host.state, .working)
        XCTAssertEqual(host.ducklings?.running, 1)
        let s = surface(t, host)
        XCTAssertEqual(s.activity, .ducklingsOnly(turnOpen: true))
        XCTAssertFalse(s.showsRunningRow, "no Working line, glyph or timer for the turn")
        XCTAssertNil(s.dock.line)
        XCTAssertFalse(s.stopInComposer, "no big stop button in the composer")
        XCTAssertTrue(s.stopOnBar, "a quiet Stop on the ducklings bar")
        XCTAssertEqual(s.dock.readyLine, "1 duckling working")
        XCTAssertEqual(DucklingWords.barText(host.ducklings, now: now), "1 duckling working")
        // The sidebar, dashboard and tab mark is the still ducklings mark; the section is working for the board.
        XCTAssertTrue(s.markIsStill)
        XCTAssertEqual(SessionGrouping.kind(of: s.session, now: now), .working)
        // The composer stays usable and queues or steers, because Claude is mid-turn.
        XCTAssertTrue(s.queuesAndSteers)
        XCTAssertEqual(s.placeholder, "Message — Claude reads it when the duckling reports back")
        XCTAssertEqual(ComposerPrompt.button(phase: .working, hasContent: false, canStop: s.stopInComposer), .disabled)
        // The duckling's step is still a row of the turn, running.
        let step = try XCTUnwrap(t.current?.steps.first { $0.id == "toolu_0124EKrK6HG87M5KHHeu3A17" })
        XCTAssertEqual(step.status, .running)
        XCTAssertEqual(step.label, "Start Fix meeting UI polish items")
    }

    func testTheWorkingStateReturnsWhenTheDucklingReportsAndClaudeThinksWithoutAnyRowMoving() throws {
        var (host, t, events) = try load("duckling-only-foreground")
        let before = t.current!.steps.map(\.id)
        var seq = events.last!.seq
        func next() -> Int { seq += 1; return seq }
        // The duckling's tool result arrives: nothing runs for a moment, which is Claude's to do.
        t.apply(Log.step(next(), "t317648", "toolu_0124EKrK6HG87M5KHHeu3A17", .tool, "Start Fix meeting UI polish items", .done))
        host.ducklings = DucklingSet(running: 0, items: [Duckling(id: "toolu_0124EKrK6HG87M5KHHeu3A17", title: "Fix", status: .done)])
        var s = surface(t, host)
        XCTAssertEqual(s.activity, .claude)
        XCTAssertTrue(s.showsRunningRow)
        // Then Claude thinks.
        t.apply(Log.step(next(), "t317648", "msg_new:0", .thinking, "Thinking…", .running))
        s = surface(t, host)
        XCTAssertEqual(s.activity, .claude)
        XCTAssertTrue(s.showsRunningRow && s.stopInComposer && !s.stopOnBar)
        XCTAssertEqual(s.placeholder, "Steer Claude — it reads this at its next step")
        // Rows only grew, in the same order: the duckling's row did not vanish or move.
        let after = t.current!.steps.map(\.id)
        XCTAssertEqual(Array(after.prefix(before.count)), before)
        XCTAssertEqual(after.count, before.count + 1)
        XCTAssertEqual(t.current!.steps.first { $0.id == "toolu_0124EKrK6HG87M5KHHeu3A17" }?.status, .done)
    }

    func testTheTurnEndingWithTheDucklingStillRunningIsReadyWithTheBar() throws {
        var (host, t, events) = try load("duckling-only-foreground")
        t.apply(Log.end(events.last!.seq + 1, "t317648"))
        host.state = .finished  // the host's own word once its turn ended
        let s = surface(t, host)
        XCTAssertEqual(s.activity, .ducklingsOnly(turnOpen: false))
        XCTAssertFalse(s.showsRunningRow)
        XCTAssertFalse(s.stopInComposer)
        XCTAssertFalse(s.stopOnBar, "a background duckling after the turn has no stop")
        XCTAssertTrue(s.markIsStill)
        XCTAssertEqual(s.dock.readyLine, "Ready · 1 duckling running")
    }

    // MARK: The second chat, as it really was

    func testASecondChatRunningACommandIsClaudeWorkingEvenWithDucklings() throws {
        let (host, t, events) = try load("duckling-only-bash-wait")
        // Its running step is a Bash `until grep …` poll, not a duckling: Claude is running a tool.
        XCTAssertEqual(host.ducklings?.running, 1)
        XCTAssertEqual(surface(t, host).activity, .claude)
        XCTAssertTrue(surface(t, host).showsRunningRow)
        // When the poll ends and the turn with it, the duckling alone remains.
        var t2 = t
        var h2 = host
        t2.apply(Log.step(events.last!.seq + 1, "a317802", "toolu_01W7GKUdCnx5dQQQzzzitEHJ", .tool, "Wait for splash agent's build result", .done))
        t2.apply(Log.end(events.last!.seq + 2, "a317802"))
        h2.state = .finished
        let s = surface(t2, h2)
        XCTAssertEqual(s.activity, .ducklingsOnly(turnOpen: false))
        XCTAssertFalse(s.showsRunningRow)
        XCTAssertTrue(s.markIsStill)
    }

    // MARK: Every list reads the one definition

    func testEveryListReadsTheHostFlagForAChatItDoesNotHaveOpen() throws {
        var (host, _, _) = try load("duckling-only-foreground")
        host.hostDucklingsOnly = true
        let out = ClaudeActivity.apply([host], open: nil)[0]
        XCTAssertEqual(out.state, .finished)
        XCTAssertEqual(out.turnOpen, true)
        XCTAssertTrue(ChatMark.of(out, unread: true, now: now)?.quiet == true, "still, even when unread")
        XCTAssertEqual(SessionGrouping.kind(of: out, now: now), .working)
        // Without the flag (an older host) the chat is working, as before.
        host.hostDucklingsOnly = nil
        XCTAssertEqual(ClaudeActivity.apply([host], open: nil)[0].state, .working)
        // A chat that is not Squeak's is untouched.
        var other = host
        other.hostDucklingsOnly = true
        other.key = SessionKey(provider: "conductor", workspaceId: nil, hostSessionId: "x")
        XCTAssertEqual(ClaudeActivity.apply([other], open: nil)[0].state, .working)
    }

    func testBlockedAndErroredChatsAreNeverReadAsDucklingsOnly() throws {
        var (host, t, _) = try load("duckling-only-foreground")
        host.state = .blocked
        XCTAssertEqual(ClaudeActivity.apply(to: host, activity: ClaudeActivity.resolve(turn: t.current, session: host)).state, .blocked)
    }

    // MARK: Randomised interleavings

    private struct SplitMix: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    func testRandomInterleavingsMatchTheReferenceRuleAndRowsOnlyGrow() {
        for seed in 0..<300 {
            var rng = SplitMix(state: UInt64(seed) &* 7919 &+ 1)
            var t = TurnTimeline()
            var seq = 1
            t.load([Log.start(seq, "t1", "go")])
            let host0 = HostSession(key: SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: "native:c1"), state: .working)
            var host = host0
            host.state = .working
            // Reference bookkeeping, independent of the timeline: how many of each kind are running.
            var runningOther = 0
            var runningDucklings: [String] = []
            var openOther: [(id: String, kind: TimelineStepKind)] = []
            var items: [Duckling] = []
            var counter = 0
            var order: [String] = []
            for _ in 0..<Int.random(in: 6...40, using: &rng) {
                counter += 1
                seq += 1
                switch Int.random(in: 0..<6, using: &rng) {
                case 0:  // a duckling launches (foreground or background-style, both are running steps until their result)
                    let id = "toolu_d\(counter)"
                    t.apply(Log.step(seq, "t1", id, .tool, "Start duckling \(counter)", .running))
                    runningDucklings.append(id)
                    items.append(Duckling(id: id, title: "d\(counter)", status: .running))
                case 1:  // a duckling's result
                    guard !runningDucklings.isEmpty else { seq -= 1; continue }
                    let id = runningDucklings.remove(at: Int.random(in: 0..<runningDucklings.count, using: &rng))
                    t.apply(Log.step(seq, "t1", id, .tool, "Start duckling", .done))
                    if let i = items.firstIndex(where: { $0.id == id }) { items[i].status = .done }
                case 2:  // thinking, a tool or a wait begins
                    let kind: TimelineStepKind = [.thinking, .tool, .waiting].randomElement(using: &rng)!
                    let id = "s\(counter)"
                    t.apply(Log.step(seq, "t1", id, kind, kind == .tool ? "Run ls" : "x", .running))
                    openOther.append((id, kind))
                    runningOther += 1
                case 3:  // one of them ends
                    guard !openOther.isEmpty else { seq -= 1; continue }
                    let s = openOther.remove(at: Int.random(in: 0..<openOther.count, using: &rng))
                    t.apply(Log.step(seq, "t1", s.id, s.kind, "x", .done))
                    runningOther -= 1
                case 4:  // a note and a steer: never Claude work
                    t.apply(Log.step(seq, "t1", "n\(counter)", [.note, .steer].randomElement(using: &rng)!, "n", .running))
                default:  // a finished reply
                    t.apply(Log.reply(seq, "t1", "native-\(counter)", "text"))
                }
                host.ducklings = DucklingSet(running: runningDucklings.count, items: items)
                let got = ClaudeActivity.resolve(turn: t.current, session: host)
                // Reference: only a duckling works when something runs and every running thing is a duckling.
                let expected: ClaudeActivity = runningOther == 0 && !runningDucklings.isEmpty ? .ducklingsOnly(turnOpen: true) : .claude
                XCTAssertEqual(got, expected, "seed \(seed) step \(counter)")
                // Rows only grow and never move.
                let ids = t.current!.steps.map(\.id)
                XCTAssertEqual(Array(ids.prefix(order.count)), order, "seed \(seed): a row moved or vanished")
                order = ids
                // The window agrees with the definition.
                let screen = DucklingSurface.make(timeline: t, host: host, now: Log.t0.addingTimeInterval(1000))
                XCTAssertEqual(screen.showsRunningRow, !expected.onlyDucklings, "seed \(seed)")
                XCTAssertEqual(screen.stopInComposer, !expected.onlyDucklings, "seed \(seed)")
                XCTAssertEqual(screen.stopOnBar, expected.turnOpen, "seed \(seed)")
            }
            // The turn ends: ducklings that still run are the only thing left; none, and nothing is.
            t.apply(Log.end(seq + 1, "t1"))
            host.state = .finished
            let got = ClaudeActivity.resolve(turn: t.turns.last, session: host)
            XCTAssertEqual(got, runningDucklings.isEmpty ? .none : .ducklingsOnly(turnOpen: false), "seed \(seed) ended")
        }
    }
}
