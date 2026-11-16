import XCTest
@testable import SqueakMacCore

/// The chat must never glitch: whatever order, delay or number of copies the host's events and pending changes arrive
/// in, and whenever the person presses Send, Queue or Steer, every frame the transcript draws keeps these rules:
///
///  1. Each message is in one row at most (never shown twice).
///  2. A message, once shown, stays shown (never vanishes, never flickers).
///  3. A row, once drawn, keeps its id; one that went away never comes back.
///  4. Rows that stay keep their order (nothing jumps above or below another).
///  5. Every way of arriving ends in the same transcript.
final class ChatFeedStabilityTests: XCTestCase {
    private static let aarav = TimelineAuthor(id: "m2", name: "Aarav")

    /// What happens in a session, in the host's order. A press is the Mac's own (before the host can echo it).
    private enum Action {
        case press(nonce: String, text: String, mode: Press)
        case host(TimelineEvent)
        case pending(NativePendingChange)
        case delta(ReplyDelta)
    }

    private enum Press { case send, queue, steer }

    private struct Script {
        var actions: [Action] = []
        var seq = 0
        mutating func host(_ body: TimelineEvent.Body) {
            seq += 1
            actions.append(.host(TimelineEvent(seq: seq, at: Date(timeIntervalSince1970: 1_800_000_000 + Double(seq)), body: body)))
        }
        mutating func step(_ turn: String, _ id: String, _ kind: TimelineStepKind, _ label: String, _ status: TimelineStepStatus,
                           detail: [String: NativeJSON] = [:], author: TimelineAuthor? = nil) {
            host(.step(TimelineStepEvent(turnId: turn, stepId: id, kind: kind, label: label, detail: detail, status: status, author: author)))
        }
    }

    /// Two people in one chat: a send, tool calls, a note being written, our queued message, Aarav's queued message, our
    /// steer read mid-turn, Aarav's steer, the reply, then both queued messages started in order.
    private static func session() -> (script: [Action], texts: [String]) {
        var s = Script()
        s.actions.append(.press(nonce: "n1", text: "fix the chat", mode: .send))
        s.host(.turnStarted(turnId: "t1", promptMessageId: "native-1", clientNonce: "n1", text: "fix the chat", author: nil, queuedId: nil, auto: false))
        s.step("t1", "tu1", .tool, "Read file", .running)
        s.step("t1", "tu1", .tool, "Read file", .done)
        s.actions.append(.delta(ReplyDelta(turnId: "t1", blockKey: "b1", offset: 0, text: "Looking at ")))
        s.actions.append(.delta(ReplyDelta(turnId: "t1", blockKey: "b1", offset: 11, text: "the view")))
        s.host(.replyDone(turnId: "t1", messageId: "native-5", blockKey: "b1", text: "Looking at the view"))
        s.actions.append(.press(nonce: "n2", text: "then the queue", mode: .queue))
        s.host(.promptQueued(queuedId: "q2", text: "then the queue", author: nil, clientNonce: "n2"))
        s.actions.append(.pending(.add(NativePendingItem(id: "q2", text: "then the queue", state: .queued))))
        s.host(.promptQueued(queuedId: "q3", text: "aarav asks", author: aarav, clientNonce: "a1"))
        s.actions.append(.pending(.add(NativePendingItem(id: "q3", text: "aarav asks", state: .queued))))
        s.actions.append(.press(nonce: "n4", text: "steer this", mode: .steer))
        s.step("t1", "steer-20", .steer, "steer this", .running, detail: ["text": .string("steer this"), "messageId": .string("native-20"), "clientNonce": .string("n4")])
        s.actions.append(.pending(.add(NativePendingItem(id: "s4", text: "steer this", state: .steering, seq: 20))))
        s.step("t1", "steer-21", .steer, "aarav steers", .running, detail: ["text": .string("aarav steers"), "messageId": .string("native-21")], author: aarav)
        s.actions.append(.pending(.add(NativePendingItem(id: "s5", text: "aarav steers", state: .steering, seq: 21))))
        s.step("t1", "tu2", .tool, "Edit files", .running)
        s.step("t1", "steer-20", .steer, "steer this", .done, detail: ["text": .string("steer this"), "messageId": .string("native-20"), "clientNonce": .string("n4")])
        s.actions.append(.pending(.remove(id: "s4", consumed: true, seq: 20)))
        s.step("t1", "tu2", .tool, "Edit files", .done)
        s.step("t1", "steer-21", .steer, "aarav steers", .done, detail: ["text": .string("aarav steers"), "messageId": .string("native-21")], author: aarav)
        s.actions.append(.pending(.remove(id: "s5", consumed: true, seq: 21)))
        s.actions.append(.delta(ReplyDelta(turnId: "t1", blockKey: "b2", offset: 0, text: "Done.")))
        s.host(.replyDone(turnId: "t1", messageId: "native-30", blockKey: "b2", text: "Done."))
        s.host(.turnEnded(turnId: "t1", outcome: .done, error: nil, replyMessageId: "native-30"))
        s.actions.append(.pending(.remove(id: "q2", consumed: true, seq: nil)))
        s.host(.turnStarted(turnId: "t31", promptMessageId: "native-31", clientNonce: "n2", text: "then the queue", author: nil, queuedId: "q2", auto: false))
        s.step("t31", "tu3", .tool, "Run tests", .done)
        s.host(.replyDone(turnId: "t31", messageId: "native-33", blockKey: "b3", text: "Queue done."))
        s.host(.turnEnded(turnId: "t31", outcome: .done, error: nil, replyMessageId: "native-33"))
        s.actions.append(.pending(.remove(id: "q3", consumed: true, seq: nil)))
        s.host(.turnStarted(turnId: "t35", promptMessageId: "native-35", clientNonce: "a1", text: "aarav asks", author: aarav, queuedId: "q3", auto: false))
        s.host(.replyDone(turnId: "t35", messageId: "native-36", blockKey: "b4", text: "Answered Aarav."))
        s.host(.turnEnded(turnId: "t35", outcome: .done, error: nil, replyMessageId: "native-36"))
        return (s.actions, ["fix the chat", "then the queue", "aarav asks", "steer this", "aarav steers"])
    }

    /// The Mac's side: the timeline, the pending stack, and the press calls the composer makes.
    private struct Mac {
        var timeline = TurnTimeline()
        var pending = NativePendingStack()

        init() { timeline.load([]) }

        mutating func press(_ nonce: String, _ text: String, _ mode: Press) {
            let working = timeline.isWorking
            switch mode {
            case .steer where working: timeline.steer(nonce: nonce, text: text, at: Date())
            default: timeline.send(nonce: nonce, text: text, at: Date(), behindTurn: working)
            }
        }

        var feed: ChatFeed { ChatFeed(timeline, pending: pending) }

        /// The rows drawn, with the person's words a row shows (nil for the agent's rows).
        var rows: [(id: String, words: String?)] {
            let f = feed
            var out: [(String, String?)] = []
            for t in f.turns {
                switch ChatFeed.promptStyle(t) {
                case .bubble: out.append(("prompt:\(t.id)", t.prompt))
                case .queuedLine: out.append(("queued:\(t.id)", t.prompt))
                case .none: break
                }
                for seg in TimelineSteps.segments(of: t) {
                    if case .steer(_, let text, _) = seg { out.append((seg.id, text)) } else { out.append((seg.id, nil)) }
                }
                if t.id == f.streamingTurn, let s = t.streaming, !s.text.isEmpty { out.append(("streaming:\(t.id)", nil)) }
            }
            out += f.looseSteers.map { ("loose:\($0.id)", $0.text) }
            return out
        }
    }

    private struct Rng: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// Rows that fold or are replaced by design: a turn's work folds into one line when it ends, and the text being
    /// written becomes the finished message in the same place.
    private static func isTransient(_ id: String) -> Bool { id.hasPrefix("work-") || id.hasPrefix("streaming:") }

    func testNoArrivalOrderEverDuplicatesMovesOrFlickersARow() {
        let (script, texts) = Self.session()
        var finals: [[String]] = []
        for seed in 0..<600 {
            var rng = Rng(state: UInt64(seed) &* 7919 &+ 1)
            var mac = Mac()
            // Each host event and pending change goes out when the host makes it, and arrives a random number of steps
            // later (so streams overtake each other), sometimes twice. Presses happen at once, in their place.
            var inFlight: [(due: Int, action: Action)] = []
            var delivered: [TimelineEvent] = []
            var prev: [(id: String, words: String?)] = []
            var gone: Set<String> = []
            var shownWords: Set<String> = []
            var clock = 0

            func frame(_ why: String) {
                let rows = mac.rows
                let ids = rows.map(\.id)
                XCTAssertEqual(Set(ids).count, ids.count, "seed \(seed) \(why): a row id twice: \(ids)")
                for w in texts {
                    let n = rows.filter { $0.words == w }.count
                    XCTAssertLessThanOrEqual(n, 1, "seed \(seed) \(why): \"\(w)\" drawn \(n) times: \(ids)")
                    if shownWords.contains(w) { XCTAssertEqual(n, 1, "seed \(seed) \(why): \"\(w)\" vanished: \(ids)") }
                    if n == 1 { shownWords.insert(w) }
                }
                let stable = ids.filter { !Self.isTransient($0) }
                for id in stable where gone.contains(id) { XCTFail("seed \(seed) \(why): \(id) came back after going: \(ids)") }
                let before = prev.map(\.id).filter { !Self.isTransient($0) }
                let kept = before.filter { stable.contains($0) }
                XCTAssertEqual(stable.filter { kept.contains($0) }, kept, "seed \(seed) \(why): rows changed order: \(before) -> \(stable)")
                for id in before where !stable.contains(id) { gone.insert(id) }
                prev = rows
            }

            func deliver(_ a: Action) {
                switch a {
                case .host(let e):
                    mac.timeline.apply(e)
                    delivered.append(e)
                    // Now and then the chat re-reads everything the host sent so far (a reconnect): copies change nothing.
                    if Int.random(in: 0..<10, using: &rng) == 0 { mac.timeline.load(delivered.sorted { $0.seq < $1.seq }) }
                case .pending(let c): mac.pending.apply(c)
                case .delta(let d): mac.timeline.apply(d)
                case .press: break
                }
                frame("deliver")
            }

            for action in script {
                clock += 1
                if case .press(let n, let t, let m) = action {
                    mac.press(n, t, m)
                    frame("press \(t)")
                } else {
                    inFlight.append((clock + Int.random(in: 0...3, using: &rng), action))
                    if Int.random(in: 0..<6, using: &rng) == 0 { inFlight.append((clock + Int.random(in: 0...5, using: &rng), action)) }
                }
                // A press waits for what the host sent before it to arrive? No: the Mac presses whenever the person does,
                // with anything still in flight. Deliver whatever is due, in a random order among the due ones.
                var due = inFlight.filter { $0.due <= clock }
                inFlight.removeAll { $0.due <= clock }
                due.shuffle(using: &rng)
                for d in due { deliver(d.action) }
            }
            for d in inFlight.shuffled(using: &rng) { deliver(d.action) }
            finals.append(mac.rows.map(\.id))
        }
        // A step that reached this Mac after the person pressed Steer sits after the steer (where they saw it go), so
        // within a turn the order can follow the press; the rows, and the order of the turns, are always the same.
        XCTAssertEqual(Set(finals.map { Set($0) }).count, 1, "every way of arriving ends with the same rows")
        XCTAssertEqual(Set(finals.map { $0.filter { $0.hasPrefix("prompt:") || $0.hasPrefix("queued:") }.joined(separator: "|") }).count, 1,
                       "and the same turns in the same order")
        XCTAssertEqual(finals.first?.filter { $0.hasPrefix("steer") }.count, 2, "both steers are in the transcript, once each")
    }
}
