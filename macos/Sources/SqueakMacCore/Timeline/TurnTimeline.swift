import Foundation

/// One step of a turn: a thought, a tool call, a note, a steer, a wait. Keyed by the host's step id (a tool id or a
/// block key), so later events for it change it in place and its position never moves.
public struct TimelineStep: Equatable, Identifiable, Sendable {
    public var id: String
    public var kind: TimelineStepKind
    /// What it says. For a message (`isMessage`) the whole text.
    public var label: String
    public var detail: [String: NativeJSON]
    public var status: TimelineStepStatus
    public var at: Date?
    public var author: TimelineAuthor?
    /// A text message of the agent (`reply.done`): the turn's last one is its reply, the others are notes.
    public var isMessage: Bool
}

public struct TimelineTurn: Equatable, Identifiable, Sendable {
    public enum State: Equatable, Sendable {
        /// Pressed on this Mac, not yet named by the host.
        case sending
        /// The host holds it behind a running turn.
        case queued
        case running
        case ended(TimelineOutcome)
        /// The send did not go; the words stay on the row.
        case notSent(String)
    }

    public struct Streaming: Equatable, Sendable {
        public var blockKey: String
        public var text: String
    }

    /// The row's key in a view. A turn made on this Mac keeps the key it had while it was only a press, so the
    /// host naming it never makes a second row or moves the first.
    public var id: String
    /// The host's id (`t<seq of the prompt row>`); nil until the host has named the turn.
    public var turnId: String?
    public var promptMessageId: String?
    public var prompt: String
    public var author: TimelineAuthor?
    public var clientNonce: String?
    /// The agent began it by itself (a helper reported in): no prompt.
    public var auto: Bool
    public var steps: [TimelineStep]
    public var state: State
    public var startedAt: Date?
    public var endedAt: Date?
    public var error: String?
    public var replyMessageId: String?
    public var streaming: Streaming?
    public var queuedId: String?
    /// The host seq of the event that started it: where an earlier page ends.
    public var startSeq: Int?
    /// A press made while another turn ran: it waits in the queue, so it is drawn as the queue's one-line row from the press.
    public var behindTurn = false

    public var isRunning: Bool {
        switch state {
        case .running, .sending, .queued: true
        default: false
        }
    }

    /// A prompt the host holds behind a running turn and has not started.
    public var waitsInQueue: Bool { turnId == nil && state == .queued }

    public var isEnded: Bool { if case .ended = state { true } else { false } }

    /// The final text of an ended turn, drawn outside its steps.
    public var reply: TimelineStep? {
        guard isEnded, let id = replyMessageId else { return nil }
        return steps.first { $0.id == id && $0.isMessage }
    }

    /// What a turn lists as steps: its thoughts, tool calls, notes and steers; not the reply, the waits or the progress tracker.
    public var listedSteps: [TimelineStep] {
        let replyId = reply?.id
        return steps.filter { s in
            switch s.kind {
            case .waiting, .retrying, .progress: false
            default: s.id != replyId
            }
        }
    }

    /// Work a person would count: thoughts and tool calls.
    public var workCount: Int { steps.filter { $0.kind == .tool || ($0.kind == .thinking && $0.status != .running) }.count }

    public var progress: TimelineStep? { steps.last { $0.kind == .progress } }

    /// The wait the turn is in, if the host says the request is out and nothing came back.
    public var openWait: TimelineStep? { steps.last { ($0.kind == .waiting || $0.kind == .retrying) && $0.status == .running } }

    /// "Worked for 1m 42s · 6 steps": nil when the turn did nothing to show.
    public var foldedTitle: String? {
        let n = workCount
        guard n > 0 else { return nil }
        var lead = "Worked"
        if let a = startedAt, let b = endedAt, b.timeIntervalSince(a) >= 1 { lead += " for \(ElapsedFormat.short(b.timeIntervalSince(a)))" }
        return "\(lead) · \(n) \(n == 1 ? "step" : "steps")"
    }

    /// The one line a running turn says in its fixed-height status row. It reads the clock, so the row changes its
    /// text in place without any event arriving.
    public func statusLine(now: Date) -> String {
        switch state {
        case .sending: return "Sending…"
        case .queued: return "Queued"
        case .ended, .notSent: return ""
        case .running: break
        }
        if let w = openWait {
            let base = w.kind == .retrying ? w.label : "Waiting for Claude"
            let since = w.detail["since"]?.double.map { Date(timeIntervalSince1970: $0 > 100_000_000_000 ? $0 / 1000 : $0) } ?? w.at
            if let since, let e = Self.elapsed(now.timeIntervalSince(since)) { return "\(base) · \(e)" }
            return base
        }
        if let s = steps.last(where: { $0.status == .running && ($0.kind == .tool || $0.kind == .thinking) }) { return s.label }
        if streaming != nil { return "Writing…" }
        return startedAt.map { now.timeIntervalSince($0) >= 60 ? "Working… \(ElapsedFormat.short(now.timeIntervalSince($0)))" : "Working…" } ?? "Working…"
    }

    /// "4m", "1h 5m"; under a minute nothing.
    static func elapsed(_ s: TimeInterval) -> String? {
        let m = Int(s / 60)
        if m < 1 { return nil }
        return m < 60 ? "\(m)m" : "\(m / 60)h \(m % 60)m"
    }
}

public struct TimelineQueued: Equatable, Identifiable, Sendable {
    public var id: String
    public var text: String
    public var author: TimelineAuthor?
    public var clientNonce: String?
}

/// The open chat's feed, as a pure reducer over the host's event log. It is the only thing a native chat's rows are made of:
///
///  - **Idempotent by seq.** An event at or below `lastSeq` changes nothing; one past `lastSeq + 1` is held until the
///    ones before it arrive (`gapSince` says what to ask the host for), so any order of arrival and any number of
///    copies reduce to the same timeline.
///  - **Rows only grow.** A turn, once in `turns`, stays at its place; a step stays at its place and is updated in place;
///    an ended turn takes no more events.
///  - **A step belongs to the turn its event names.** Nothing is "the current turn" by position or by guess, so a new
///    prompt can never show the last turn's work.
///  - **A send is a row at once** (`send`), reconciled in place by the nonce the host echoes.
public struct TurnTimeline: Equatable, Sendable {
    public private(set) var turns: [TimelineTurn] = []
    public private(set) var queued: [TimelineQueued] = []
    /// The newest seq applied with none missing before it.
    public private(set) var lastSeq = 0
    /// Older turns exist on the host than the ones held.
    public private(set) var hasEarlier = false
    /// False until a first page (or `acceptGap`) says where the log starts.
    public private(set) var hasBaseline = false
    private var held: [Int: TimelineEvent] = [:]

    public init() {}

    public enum Applied: Equatable, Sendable {
        case applied
        case duplicate
        /// Held: ask the host for events after this seq.
        case held(gapSince: Int)
    }

    /// Set while events wait behind a missing one.
    public var gapSince: Int? { held.isEmpty ? nil : lastSeq }

    /// The seq an earlier page is asked before: the oldest turn held started there.
    public var oldestSeq: Int? { turns.compactMap(\.startSeq).min() }

    /// The turn the agent is working on. A prompt waiting behind it is a row after it but never "the current turn".
    public var current: TimelineTurn? { turns.last(where: { $0.state == .running }) ?? turns.last(where: { $0.isRunning }) }
    public var isWorking: Bool { current != nil }

    // MARK: Loading

    /// A page of the log (the first read, or a refetch): the first event of a first page sets where the log starts.
    public mutating func load(_ events: [TimelineEvent], hasEarlier more: Bool? = nil) {
        // A baseline that holds no turn (a stale or empty one) cannot be the place a first page continues from: a page
        // that starts past it would be held behind a gap for good, and the chat would show nothing but "Load earlier".
        let staleBaseline = hasBaseline && turns.isEmpty && (events.first.map { $0.seq > lastSeq + 1 } ?? false)
        if !hasBaseline || staleBaseline {
            if staleBaseline { held = [:] }
            lastSeq = max(0, (events.first?.seq ?? 1) - 1)
            hasBaseline = true
            if let more { hasEarlier = more }
        }
        for e in events { _ = apply(e) }
    }

    /// The turns before the ones held (an earlier page): placed above, nothing held moves.
    public mutating func prepend(_ events: [TimelineEvent], hasEarlier more: Bool) {
        var older = TurnTimeline()
        older.load(events)
        let known = Set(turns.compactMap(\.turnId))
        // A prompt that was only waiting in an older page has long since started or gone: it is not a row.
        turns = older.turns.filter { !$0.waitsInQueue && ($0.turnId.map { !known.contains($0) } ?? true) } + turns
        hasEarlier = more
    }

    /// The log cannot supply what is missing (a pond that trimmed it): go on past the gap.
    public mutating func acceptGap() {
        guard let next = held.keys.min() else { return }
        lastSeq = next - 1
        drain()
    }

    // MARK: Events

    @discardableResult
    public mutating func apply(_ e: TimelineEvent) -> Applied {
        guard hasBaseline else {
            held[e.seq] = e
            return .held(gapSince: lastSeq)
        }
        if e.seq <= lastSeq { return .duplicate }
        if e.seq > lastSeq + 1 {
            held[e.seq] = e
            return .held(gapSince: lastSeq)
        }
        reduce(e)
        lastSeq = e.seq
        drain()
        return .applied
    }

    private mutating func drain() {
        while let next = held[lastSeq + 1] {
            held[lastSeq + 1] = nil
            reduce(next)
            lastSeq += 1
        }
        held = held.filter { $0.key > lastSeq }
    }

    /// The message being written. Only the running turn takes it, and only in order: a chunk that skips ahead is ignored
    /// (the persisted message follows), one that repeats is trimmed.
    public mutating func apply(_ d: ReplyDelta) {
        guard let i = turns.lastIndex(where: { $0.turnId == d.turnId }), turns[i].state == .running else { return }
        var s = turns[i].streaming
        if s?.blockKey != d.blockKey { s = d.offset == 0 ? TimelineTurn.Streaming(blockKey: d.blockKey, text: "") : nil }
        guard var cur = s else { return }
        let have = cur.text.utf16.count
        guard d.offset <= have else { return }
        let skip = have - d.offset
        guard skip < d.text.utf16.count else { return }
        cur.text += skip == 0 ? d.text : String(d.text.utf16.dropFirst(skip)) ?? ""
        turns[i].streaming = cur
    }

    private mutating func reduce(_ e: TimelineEvent) {
        switch e.body {
        case .turnStarted(let turnId, let promptId, let nonce, let text, let author, let queuedId, let auto):
            guard !turns.contains(where: { $0.turnId == turnId }) else { return }
            // A steer press the host started as a turn of its own (the turn it aimed at had ended): it is that turn's prompt.
            if let n = nonce, let (ti, si) = localSteer(nonce: n), turns[ti].steps[si].detail["messageId"] == nil { turns[ti].steps.remove(at: si) }
            if let i = pendingIndex(nonce: nonce, text: text, author: author, queuedId: queuedId, at: e.at ?? Date()) {
                turns[i].turnId = turnId
                turns[i].promptMessageId = promptId
                turns[i].queuedId = nil
                turns[i].state = .running
                turns[i].startedAt = e.at
                turns[i].startSeq = e.seq
                turns[i].author = author
                queued.removeAll { $0.id == queuedId || ($0.clientNonce != nil && $0.clientNonce == nonce) }
                return
            }
            // A turn running when another starts missed its end (a trimmed log): it is over.
            for j in turns.indices where turns[j].state == .running { turns[j].state = .ended(.stopped); turns[j].streaming = nil }
            queued.removeAll { $0.id == queuedId }
            let turn = TimelineTurn(
                id: turnId, turnId: turnId, promptMessageId: promptId, prompt: text, author: author, clientNonce: nonce, auto: auto,
                steps: [], state: .running, startedAt: e.at, endedAt: nil, error: nil, replyMessageId: nil, streaming: nil, queuedId: nil,
                startSeq: e.seq)
            // Host order is the order: a turn the host started goes above any of our presses it has not named yet.
            let at = turns.firstIndex(where: { $0.turnId == nil }) ?? turns.count
            turns.insert(turn, at: at)

        case .promptQueued(let id, let text, let author, let nonce):
            // A steer press the host could not hand the agent: it waits in the queue like any other message.
            if let n = nonce, let (ti, si) = localSteer(nonce: n) { turns[ti].steps.remove(at: si) }
            if let n = nonce, let i = turns.firstIndex(where: { $0.clientNonce == n && $0.turnId == nil }) {
                turns[i].state = .queued
                turns[i].queuedId = id
            } else if nonce == nil, author == nil, !turns.contains(where: { $0.queuedId == id }),
                      let i = turns.firstIndex(where: { $0.turnId == nil && $0.state == .sending && $0.prompt == text }) {
                // Our own press whose nonce was lost on the way: the one press of the same words.
                turns[i].state = .queued
                turns[i].queuedId = id
            } else if !turns.contains(where: { $0.queuedId == id }), let i = staleIndex(text: text, author: author, at: e.at ?? Date()) {
                turns[i].state = .queued
                turns[i].queuedId = id
            } else if !turns.contains(where: { $0.queuedId == id }) {
                // Someone else's prompt (a pond member's), or ours from another surface: a dimmed row at the end of the
                // transcript under its author, which becomes the turn's prompt in place when the host starts it.
                turns.append(TimelineTurn(
                    id: "queued-\(id)", turnId: nil, promptMessageId: nil, prompt: text, author: author, clientNonce: nonce, auto: false,
                    steps: [], state: .queued, startedAt: e.at, endedAt: nil, error: nil, replyMessageId: nil, streaming: nil, queuedId: id,
                    startSeq: nil))
            }
            if !queued.contains(where: { $0.id == id }) { queued.append(TimelineQueued(id: id, text: text, author: author, clientNonce: nonce)) }

        case .promptDequeued(let id):
            queued.removeAll { $0.id == id }
            // Taken out (deleted, or steered into the running turn): the waiting row goes; nothing else moves.
            turns.removeAll { $0.queuedId == id && $0.turnId == nil && $0.state == .queued }

        case .step(let s):
            // A steer our composer sent: the host took it into the turn. The step we drew at the press becomes it, in
            // place and under the same row id, so nothing moves; an older Mac's press row (a turn of its own) goes.
            if s.kind == .steer, case .string(let n)? = s.detail["clientNonce"] {
                turns.removeAll { $0.clientNonce == n && $0.turnId == nil && ($0.state == .sending || $0.state == .queued) }
                if let (ti, si) = localSteer(nonce: n) {
                    var step = turns[ti].steps[si]
                    step.label = s.label; step.detail = s.detail; step.status = s.status; step.author = s.author
                    turns[ti].steps[si] = step
                    return
                }
            }
            guard let i = openIndex(s.turnId) else { return }
            upsert(TimelineStep(
                id: s.stepId, kind: s.kind, label: s.label, detail: s.detail, status: s.status, at: e.at, author: s.author, isMessage: false),
                in: i)

        case .replyDone(let turnId, let messageId, _, let text):
            guard let i = openIndex(turnId) else { return }
            upsert(TimelineStep(
                id: messageId, kind: .note, label: text, detail: [:], status: .done, at: e.at, author: nil, isMessage: true), in: i)
            turns[i].streaming = nil

        case .turnEnded(let turnId, let outcome, let error, let replyId):
            guard let i = turns.lastIndex(where: { $0.turnId == turnId }), !turns[i].isEnded else { return }
            for j in turns[i].steps.indices where turns[i].steps[j].status == .running {
                turns[i].steps[j].status = outcome == .failed ? .failed : .done
            }
            turns[i].state = .ended(outcome)
            turns[i].endedAt = e.at
            turns[i].error = error
            turns[i].replyMessageId = replyId
            turns[i].streaming = nil

        case .unknown:
            break
        }
    }

    /// The open turn an event names. Events for an ended turn, or one this timeline never saw start, change nothing.
    private func openIndex(_ turnId: String) -> Int? {
        guard let i = turns.lastIndex(where: { $0.turnId == turnId }), turns[i].state == .running else { return nil }
        return i
    }

    private func pendingIndex(nonce: String?, text: String, author: TimelineAuthor?, queuedId: String?, at: Date) -> Int? {
        let open = turns.indices.filter { turns[$0].turnId == nil && (turns[$0].state == .sending || turns[$0].state == .queued) }
        if let nonce, let i = open.first(where: { turns[$0].clientNonce == nonce }) { return i }
        if let queuedId, let i = open.first(where: { turns[$0].queuedId == queuedId }) { return i }
        // A prompt whose nonce was lost on the way (a restarted host's queue): the one press of the same words, only
        // when it is our own (a teammate's prompt is never taken for it).
        if nonce == nil, author == nil, let i = open.first(where: { turns[$0].prompt == text }) { return i }
        return staleIndex(text: text, author: author, at: at)
    }

    /// An optimistic row nothing named for a while (a nonce lost on the way) and the same author's identical prompt: one row.
    private func staleIndex(text: String, author: TimelineAuthor?, at: Date) -> Int? {
        turns.indices.first { i in
            turns[i].turnId == nil && turns[i].state == .sending && turns[i].prompt == text && turns[i].author == author
                && (turns[i].startedAt.map { at.timeIntervalSince($0) > Self.staleAfter } ?? false)
        }
    }

    private static let staleAfter: TimeInterval = 10

    private mutating func upsert(_ step: TimelineStep, in i: Int) {
        if let j = turns[i].steps.firstIndex(where: { $0.id == step.id }) {
            var s = step
            // The time a step began does not move; a detail the update leaves out stays.
            s.at = turns[i].steps[j].at ?? step.at
            if s.detail.isEmpty { s.detail = turns[i].steps[j].detail }
            if s.isMessage == false, turns[i].steps[j].isMessage { s.isMessage = true }
            if turns[i].steps[j] != s { turns[i].steps[j] = s }
        } else {
            turns[i].steps.append(step)
        }
    }

    // MARK: Sending

    /// The press of Send on an idle chat: a row at once, named by the host's `turn.started` carrying this nonce.
    /// `behindTurn`: pressed while a turn runs, so the host will queue it.
    public mutating func send(nonce: String, text: String, author: TimelineAuthor? = nil, at: Date? = nil, behindTurn: Bool = false) {
        guard !turns.contains(where: { $0.clientNonce == nonce }), localSteer(nonce: nonce) == nil else { return }
        turns.append(TimelineTurn(
            id: "send-\(nonce)", turnId: nil, promptMessageId: nil, prompt: text, author: author, clientNonce: nonce, auto: false, steps: [],
            state: .sending, startedAt: at, endedAt: nil, error: nil, replyMessageId: nil, streaming: nil, queuedId: nil, startSeq: nil,
            behindTurn: behindTurn))
    }

    /// The press of Steer while a turn runs: a waiting steer step at the end of that turn at once, where the host's own
    /// step lands; the host's step (carrying this nonce) fills it in place. With no turn running it is a plain send.
    public mutating func steer(nonce: String, text: String, author: TimelineAuthor? = nil, at: Date? = nil) {
        guard !turns.contains(where: { $0.clientNonce == nonce }), localSteer(nonce: nonce) == nil else { return }
        // The running turn, or our own press the host has not named yet (it becomes that turn in place).
        guard let i = turns.lastIndex(where: { $0.state == .running }) ?? turns.lastIndex(where: { $0.turnId == nil && $0.state == .sending && !$0.behindTurn })
        else { send(nonce: nonce, text: text, author: author, at: at); return }
        turns[i].steps.append(TimelineStep(
            id: "steer-local-\(nonce)", kind: .steer, label: text, detail: ["text": .string(text), "clientNonce": .string(nonce)],
            status: .running, at: at, author: author, isMessage: false))
    }

    /// Where our own steer press sits: (turn, step).
    private func localSteer(nonce: String) -> (Int, Int)? {
        for ti in turns.indices.reversed() {
            if let si = turns[ti].steps.firstIndex(where: { $0.kind == .steer && $0.detail["clientNonce"] == .string(nonce) }) { return (ti, si) }
        }
        return nil
    }

    /// The send did not go: the row stays, saying so, until the person discards or resends it.
    public mutating func markNotSent(nonce: String, reason: String) {
        // A steer that did not go: its step goes (the words are back in the draft).
        if let (ti, si) = localSteer(nonce: nonce), turns[ti].steps[si].detail["messageId"] == nil { turns[ti].steps.remove(at: si); return }
        guard let i = turns.firstIndex(where: { $0.clientNonce == nonce && $0.turnId == nil }) else { return }
        turns[i].state = .notSent(reason)
    }

    /// An explicit discard of a row that was never sent.
    public mutating func discard(nonce: String) {
        turns.removeAll { $0.clientNonce == nonce && $0.turnId == nil && { if case .notSent = $0.state { true } else { false } }($0) }
    }

    // MARK: For the screens that read messages

    /// The turns as chat messages (a prompt, then each text message of the turn in order), for what still reads messages:
    /// the dock, the turn footers and history. Ids are the transcript's (`native-<seq>`), so they match.
    public var chatMessages: [ChatMessage] { messages(me: nil) }

    /// `me`: the viewer's own member id when this is read through a pond, so their own prompts carry no name.
    public func messages(me: String?) -> [ChatMessage] {
        var out: [ChatMessage] = []
        for t in turns {
            if let p = t.promptMessage(me: me) { out.append(p) }
            for s in t.steps where s.isMessage { out.append(t.message(for: s)) }
        }
        return out
    }
}

extension TimelineTurn {
    /// The person's words that opened the turn; nil for a turn the agent began by itself.
    public func promptMessage(me: String? = nil) -> ChatMessage? {
        guard !auto else { return nil }
        var m = ChatMessage(
            id: promptMessageId ?? "local-\(clientNonce ?? id)", role: .user, text: prompt, at: startedAt, turnId: turnId ?? id,
            authorName: TimelineLabels.author(author, me: me))
        m.clientId = clientNonce.flatMap(UUID.init(uuidString:))
        switch state {
        case .sending, .queued: m.state = .pending
        case .notSent(let why): m.state = .notSent(reason: why)
        default: break
        }
        return m
    }

    /// One of the agent's text messages of this turn.
    public func message(for step: TimelineStep) -> ChatMessage {
        ChatMessage(id: step.id, role: .assistant, text: step.label, at: step.at, turnId: turnId ?? id)
    }
}

public enum TimelineLabels {
    /// The name a prompt's author is shown under, or nil when it is you (nobody labels their own words): a prompt
    /// with no author is this Mac's own person's, and one carrying `me`'s id is the viewer's own wherever it is read.
    public static func author(_ a: TimelineAuthor?, me: String?) -> String? {
        guard let a else { return nil }
        if let me, a.id == me { return nil }
        return a.name
    }
}
