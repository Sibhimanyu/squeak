import Foundation
import SqueakCore

/// A message this phone sent, kept in memory per session. It is on screen the moment you send it
/// ("Sending…", then "Sent", or why it was refused) and stays after the agent's reply arrives.
struct ChatSend: Identifiable, Equatable {
    enum Status: Equatable {
        case sending, sent
        /// The agent was mid-turn and reads it once the turn ends. `steerUnavailable` when steering was
        /// asked for but this chat's route cannot do it, so it was queued instead.
        case queued(agent: String, steerUnavailable: Bool)
        /// Went into the turn in progress.
        case steered
        /// Written to the channel, but the Mac has not said it arrived.
        case notConfirmed
        case refused(String)
        /// The agent has it: its turn started from it, it shows in the turn, or it left the queue.
        /// Only ever worked out for display (`ChatTimeline.receipt`), never stored.
        case read(agent: String)

        /// The one line under a "You" bubble, muted: sent, queued, steered or not sent.
        var line: String {
            switch self {
            case .sending: "Sending…"
            case .sent: "Sent"
            case .queued(let agent, let unavailable):
                unavailable ? "Queued · \(agent) reads it after this turn (steering isn't available here)"
                    : "Queued · \(agent) reads it after this turn"
            case .steered: "Steered into the current turn"
            case .notConfirmed: "Not confirmed"
            case .refused(let why): "Not sent: \(why)"
            case .read(let agent): "Read by \(agent)"
            }
        }

        /// What the Mac reported for a delivered message. An older Mac says nothing, which reads as sent.
        static func delivered(_ result: CommandResult, agent: String) -> Status {
            switch result.delivery {
            case "queued": .queued(agent: agent, steerUnavailable: result.note != nil)
            case "steered": .steered
            default: .sent
            }
        }
    }
    let id: UUID
    let text: String
    let date: Date
    /// The agent turn it answered; places it before or after that turn's message.
    let answersTurn: String?
    var status: Status
    /// Conductor's id for it once queued (the phone chooses it), so its card matches the Mac's queue.
    let messageId: String
    let mode: ReplyMode
    /// Sent to queue behind a turn in progress: it waits above the composer, not in the chat.
    let queuedBehindTurn: Bool
    /// Seen in the Mac's copy of Conductor's queue; once it leaves it, it went to the agent.
    var seenInQueue = false

    init(id: UUID = UUID(), text: String, date: Date, answersTurn: String?, status: Status = .sent,
         messageId: String = UUID().uuidString.lowercased(), mode: ReplyMode = .queue, queuedBehindTurn: Bool = false) {
        self.id = id; self.text = text; self.date = date; self.answersTurn = answersTurn; self.status = status
        self.messageId = messageId; self.mode = mode; self.queuedBehindTurn = queuedBehindTurn
    }

    var isSteer: Bool { mode == .steer }
}

/// One step of a turn as the chat shows it: the snapshot's or the live turn's, the same shape.
/// `you` is a message put into the turn while it ran (a steer).
struct TurnStep: Equatable, Hashable {
    let kind: String
    let text: String
}

/// The messages waiting behind a working turn, shown as cards above the composer and never in the
/// chat (DESIGN.md §8.5). Conductor's queue, as the Mac publishes it in the live turn, is the truth;
/// this phone's own queued sends fill the gap until it shows them.
enum ChatQueue {
    struct Card: Identifiable, Equatable {
        let id: String
        let text: String
        /// Not in Conductor's queue yet as far as this phone knows ("Queuing…").
        let pending: Bool
        /// Steer now, Edit and Delete work: the Mac can read and change this chat's queue.
        let actionable: Bool
    }

    /// Long enough for the Mac to publish a message it has just queued.
    static let publishGrace: TimeInterval = 20

    /// Whether a send waits above the composer rather than showing in the chat.
    static func isQueued(_ send: ChatSend, session: PhoneSnapshot.Session, live: LiveTurn?, now: Date = Date()) -> Bool {
        guard send.queuedBehindTurn, send.mode == .queue else { return false }
        switch send.status {
        case .refused, .sent, .steered, .read: return false
        case .sending, .queued, .notConfirmed: break
        }
        if let queue = live?.queue {
            if queue.contains(where: { $0.id == send.messageId }) { return true }
            if send.seenInQueue { return false }
            if send.status == .sending { return true }
            return now.timeIntervalSince(send.date) < publishGrace
        }
        // The Mac can't read this chat's queue: it waits until the turn it queued behind is over.
        if send.status == .sending { return true }
        return session.turnId == send.answersTurn && now.timeIntervalSince(send.date) < 30 * 60
    }

    static func cards(session: PhoneSnapshot.Session, live: LiveTurn?, sends: [ChatSend], hidden: Set<String> = [], now: Date = Date()) -> [Card] {
        let live = live?.key == session.key ? live : nil
        let mine = sends.filter { isQueued($0, session: session, live: live, now: now) }
        var cards: [Card] = []
        if let queue = live?.queue {
            cards = queue.map { Card(id: $0.id, text: $0.text, pending: false, actionable: true) }
        }
        let known = Set(cards.map(\.id))
        cards += mine.filter { !known.contains($0.messageId) }.map {
            Card(id: $0.messageId, text: $0.text, pending: live?.queue != nil || $0.status == .sending, actionable: false)
        }
        return cards.filter { !hidden.contains($0.id) }
    }
}

/// The last agent message this phone saw for a session. The snapshot drops `message` while a new
/// turn works, so this keeps the previous answer on screen above the working row.
struct RememberedMessage: Equatable {
    let text: String
    /// The snapshot's ISO timestamp for it.
    let atISO: String
    let turnId: String?
}

/// What a session's chat shows, decided apart from the view so CI can test it: the snapshot, what
/// this phone sent and what it last read go in; the rows to draw come out.
///
/// A chat that is working, or that you just sent to, never shows the empty state. Your message
/// stays where you sent it; a working row sits under it ("Running tests…", "Starting…" first); the
/// previous agent message stays above, muted; the reply replaces the working row in place. A send
/// that failed shows its refusal on its bubble and starts no working row.
enum ChatTimeline {
    enum Row: Equatable, Identifiable {
        case agent(text: String, atISO: String, muted: Bool)
        case sent(ChatSend)
        /// A message put into the running turn, where it landed among the steps.
        case steer(id: String, text: String, line: String)
        /// The part of a turn before a steer (or a finished turn's steps), folded to one line.
        case folded(id: String, steps: [TurnStep])
        /// The live part of the turn: its newest steps under "Claude · Running tests…".
        case working(label: String, steps: [TurnStep] = [])
        /// Earlier in the chat, from the Mac's history: yours on the right, the agent's answers muted.
        case history(id: String, fromUser: Bool, text: String, atISO: String?)
        /// The agent's work between two messages, counted (the Mac sends how many tool calls, never what they were).
        case worked(id: String, steps: Int)
        case empty(String)

        var id: String {
            switch self {
            case .agent: "agent"
            case .sent(let s): s.id.uuidString
            case .steer(let id, _, _): id
            case .folded(let id, _): id
            case .working: "working"
            case .history(let id, _, _, _): id
            case .worked(let id, _): id
            case .empty: "empty"
            }
        }
    }

    /// A send that has not made the Mac report the agent working this long after it stops counting
    /// as "starting": the Mac's word wins. Streamed, a turn that starts shows as working within a
    /// second or two, so a send still not answered after this has not started anything. (It was ten
    /// minutes, and a chat whose turn had ended said "Starting…" inside while the list said done.)
    static let giveUp: TimeInterval = 90

    /// Whether this phone's own send makes the chat look like it is starting while the Mac does not
    /// yet say working. The list row uses it too, so the two never disagree.
    static func isStarting(session: PhoneSnapshot.Session, sends: [ChatSend], now: Date = Date()) -> Bool {
        guard session.state != "working" else { return false }
        return rows(session: session, remembered: nil, sends: sends, now: now).contains {
            if case .working = $0 { true } else { false }
        }
    }

    static func rows(
        session: PhoneSnapshot.Session, remembered: RememberedMessage?, sends allSends: [ChatSend],
        live: LiveTurn? = nil, cachedHistory: [LiveTurn.HistoryEntry]? = nil, now: Date = Date()
    ) -> [Row] {
        let working = session.state == "working"
        let live = live?.key == session.key ? live : nil
        let current: String? = working ? nil : [session.message, session.detail].compactMap { $0 }.first { !$0.isEmpty }
        // Queued messages wait above the composer, not here.
        let sends = allSends.filter { !ChatQueue.isQueued($0, session: session, live: live, now: now) }

        func replied(_ s: ChatSend) -> Bool {
            if now.timeIntervalSince(s.date) > giveUp, !working { return true }
            // A later message of this phone's own began a turn, so the turn this one started is over: with a
            // queue, the next turn follows the last at once and the chat may never be seen resting.
            if !s.isSteer, sends.contains(where: { $0.date > s.date && !$0.isSteer && startedTurn($0) }) { return true }
            guard current != nil, !working else { return false }
            if s.answersTurn == nil { return (Age.date(session.lastActivityAt) ?? .distantPast) > s.date }
            return session.turnId != s.answersTurn
        }
        func startedTurn(_ s: ChatSend) -> Bool {
            switch s.status {
            case .sent, .read, .queued: true
            default: false
            }
        }
        let awaiting = sends.filter {
            switch $0.status {
            case .refused: false
            default: !replied($0)
            }
        }
        let isWorking = working || (!awaiting.isEmpty && !session.isBlocked && session.state != "error")

        let anchorTurn = isWorking ? remembered?.turnId : session.turnId
        func after(_ s: ChatSend) -> Bool {
            if awaiting.contains(where: { $0.id == s.id }) { return true }
            return s.answersTurn != nil && s.answersTurn == anchorTurn
        }
        let agentName = Presentation.agentName(session.agent)
        let steps = turnSteps(session: session, live: live)
        /// "Sent" says the Mac has it; "Read by Claude" says the agent does. "Queued" holds while the
        /// agent is still on the turn the message waited behind.
        func settled(_ s: ChatSend) -> ChatSend {
            var copy = s
            if read(s) { copy.status = .read(agent: agentName) } else if case .queued = s.status, !working { copy.status = .sent }
            return copy
        }
        func read(_ s: ChatSend) -> Bool {
            switch s.status {
            case .sent, .queued, .steered: break
            default: return false
            }
            // The agent answered after it.
            if !working, current != nil {
                if s.answersTurn == nil { return (Age.date(session.lastActivityAt) ?? .distantPast) > s.date }
                if session.turnId != s.answersTurn { return true }
            }
            // A steer the transcript shows inside the turn.
            if s.isSteer { return steps.contains { $0.kind == "you" && same($0.text, s.text) } }
            // Queued: it left Conductor's queue, so the agent took it.
            if s.queuedBehindTurn { return s.seenInQueue && !(live?.queue?.contains { $0.id == s.messageId } ?? true) }
            // Sent to a chat that was resting: the turn it started is running.
            return working && s.status == .sent
        }
        // While the turn runs, a steer belongs inside it, among the steps.
        let steers = isWorking ? sends.filter { s in s.isSteer && awaiting.contains(where: { $0.id == s.id }) } : []
        let plain = sends.filter { s in !steers.contains(where: { $0.id == s.id }) }

        var rows: [Row] = plain.filter { !after($0) }.map { .sent(settled($0)) }
        if isWorking {
            if let r = remembered { rows.append(.agent(text: r.text, atISO: r.atISO, muted: true)) }
        } else if let current {
            // A finished turn's steps, folded above its answer, while the live turn still has them.
            if let live, !live.working, !live.steps.isEmpty {
                rows.append(.folded(id: "worked", steps: live.steps.filter { $0.kind != "you" }.map { TurnStep(kind: $0.kind, text: $0.text) }))
            }
            rows.append(.agent(text: current, atISO: session.lastActivityAt, muted: false))
        }
        rows += plain.filter(after).map { .sent(settled($0)) }
        let total = live?.total ?? session.activity?.total ?? 0
        rows = merged(Self.firstNonEmpty(live?.history, cachedHistory), tail: rows, steerTexts: steps.filter { $0.kind == "you" }.map(\.text) + steers.map(\.text), isWorking: isWorking)
        if isWorking {
            rows += turn(steps: steps, steers: steers.map(settled), truncated: total > steps.count, total: total, agentName: agentName)
        }
        return rows.isEmpty ? [.empty(emptyText(canReply: Presentation.replyBlock(session) == nil))] : rows
    }

    /// The first history that has anything in it: an empty live one (the Mac could not read the chat this
    /// moment) must not blank a good cached one.
    static func firstNonEmpty(_ histories: [LiveTurn.HistoryEntry]?...) -> [LiveTurn.HistoryEntry]? {
        histories.first { !($0?.isEmpty ?? true) } ?? nil
    }

    /// The Mac's history and what this phone already shows, in the order things happened. A history entry
    /// that is one of the rows (this phone's own send, the agent's latest answer) takes that row's place, so
    /// each message sits between the work before it and the message after it; anything the history does not
    /// know yet (a send not read yet, the newest answer) follows. The work before an entry shows even where the
    /// entry is already on screen, so a chat of several sends reads message, work, message.
    static func merged(_ history: [LiveTurn.HistoryEntry]?, tail: [Row], steerTexts: [String], isWorking: Bool) -> [Row] {
        guard let history, !history.isEmpty else { return tail }
        var used = Set<Int>()
        func take(_ matches: (Row) -> Bool) -> Int? {
            guard let i = tail.indices.first(where: { !used.contains($0) && matches(tail[$0]) }) else { return nil }
            used.insert(i)
            return i
        }
        // While a turn runs, the agent's notes after the newest real message are the steps already shown.
        var cut = history.count
        if isWorking {
            let lastUser = history.lastIndex { entry in
                entry.role == "user" && !steerTexts.contains { same(entry.text, $0) || same($0, entry.text) }
            }
            if let lastUser { cut = history[lastUser...].firstIndex { $0.role != "user" } ?? history.count }
        }
        var out: [Row] = []
        var seen: [String: Int] = [:]
        for (i, entry) in history.enumerated() {
            let fromUser = entry.role == "user"
            if i >= cut, !fromUser { continue }
            if fromUser, steerTexts.contains(where: { same(entry.text, $0) || same($0, entry.text) }) { continue }
            let work: Row? = (entry.workBefore ?? 0) > 0 ? .worked(id: "w-\(stableID(entry, &seen))", steps: entry.workBefore!) : nil
            if fromUser {
                if let work { out.append(work) }
                if let m = take({ if case .sent(let s) = $0 { same(entry.text, s.text) || same(s.text, entry.text) } else { false } }) {
                    out.append(tail[m])
                } else {
                    out.append(.history(id: stableID(entry, &seen), fromUser: true, text: entry.text, atISO: entry.at))
                }
            } else {
                if let m = take({ if case .agent(let t, _, _) = $0 { same(entry.text, t) || same(t, entry.text) } else { false } }) {
                    // The finished turn's folded steps sit just before its answer: they stand in for the count.
                    if m > 0, case .folded = tail[m - 1], !used.contains(m - 1) {
                        used.insert(m - 1)
                        out.append(tail[m - 1])
                    } else if let work { out.append(work) }
                    out.append(tail[m])
                } else {
                    if let work { out.append(work) }
                    out.append(.history(id: stableID(entry, &seen), fromUser: false, text: entry.text, atISO: entry.at))
                }
            }
        }
        for (i, row) in tail.enumerated() where !used.contains(i) {
            // A muted earlier answer the history has under other words: the history's copy stands.
            if case .agent(_, _, true) = row { continue }
            out.append(row)
        }
        return out
    }

    /// A history entry's id: what it is, never where it is in the list, so the window sliding by one does not
    /// remove and re-insert every row (which also resets what the rows remember, like an open message).
    private static func stableID(_ entry: LiveTurn.HistoryEntry, _ seen: inout [String: Int]) -> String {
        let base = "h-\(entry.role)-\(entry.at ?? "")-\(entry.text.prefix(24))"
        let n = seen[base, default: 0]
        seen[base] = n + 1
        return n == 0 ? base : "\(base)#\(n)"
    }

    /// The working turn's steps: the live turn's whole steps when the Mac streams them for this turn,
    /// else the snapshot's newest six.
    static func turnSteps(session: PhoneSnapshot.Session, live: LiveTurn?) -> [TurnStep] {
        if let live, live.working, !live.steps.isEmpty { return live.steps.map { TurnStep(kind: $0.kind, text: $0.text) } }
        return (session.activity?.steps ?? []).map { TurnStep(kind: $0.kind, text: $0.text) }
    }

    /// The turn in parts: each steer where it landed, the steps before it folded, the live part last.
    /// A steer the Mac has not reported yet goes at the end, the agent still to read it.
    static func turn(steps: [TurnStep], steers: [ChatSend], truncated: Bool, total: Int = 0, agentName: String = "the agent") -> [Row] {
        var segments: [[TurnStep]] = [[]]
        var yous: [String] = []
        for step in steps {
            if step.kind == "you" { yous.append(step.text); segments.append([]) } else { segments[segments.count - 1].append(step) }
        }
        var unmatched = steers
        var rows: [Row] = []
        // A steer that scrolled out of a clipped feed landed before everything shown.
        if truncated {
            let early = unmatched.filter { s in (s.status == .steered || s.status == .read(agent: agentName)) && !yous.contains { same($0, s.text) } }
            // The work the feed no longer holds is counted, so a steer never follows the old prompt with nothing between.
            if !early.isEmpty, total > steps.count { rows.append(.worked(id: "part-hidden", steps: total - steps.count)) }
            rows += early.map { .steer(id: $0.id.uuidString, text: $0.text, line: $0.status.line) }
            unmatched.removeAll { s in early.contains { $0.id == s.id } }
        }
        for (i, you) in yous.enumerated() {
            if !segments[i].isEmpty { rows.append(.folded(id: "part-\(i)", steps: segments[i])) }
            if let mine = unmatched.firstIndex(where: { same(you, $0.text) }) {
                let s = unmatched.remove(at: mine)
                rows.append(.steer(id: s.id.uuidString, text: s.text, line: s.status.line))
            } else {
                // Typed on the Mac: in the transcript, so the agent has it.
                rows.append(.steer(id: "you-\(i)", text: you, line: ChatSend.Status.read(agent: agentName).line))
            }
        }
        var live = segments[segments.count - 1]
        if !unmatched.isEmpty {
            if !live.isEmpty { rows.append(.folded(id: "part-\(yous.count)", steps: live)) }
            rows += unmatched.map { .steer(id: $0.id.uuidString, text: $0.text, line: $0.status.line) }
            live = []
        }
        let steered = !yous.isEmpty || !unmatched.isEmpty
        rows.append(.working(label: live.isEmpty && steered ? "Reading your message…" : workingLabel(turn: live), steps: live))
        return rows
    }

    /// The Mac's copy of a message is whitespace-flattened and may be clipped with "…".
    static func same(_ reported: String, _ sent: String) -> Bool {
        func flat(_ t: String) -> String { t.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        let a = flat(reported), b = flat(sent)
        if a == b { return true }
        guard a.hasSuffix("…") else { return false }
        return b.hasPrefix(String(a.dropLast()).trimmingCharacters(in: .whitespaces))
    }

    static func workingLabel(turn steps: [TurnStep]) -> String {
        workingLabel(steps.map { PhoneSnapshot.Step(kind: $0.kind, text: $0.text) })
    }

    /// "Running tests…", or "Starting…" before the first step; DESIGN.md §8.7 for the empty copy.
    static func workingLabel(_ steps: [PhoneSnapshot.Step]) -> String {
        guard !steps.isEmpty else { return "Starting…" }
        let phrase = Presentation.stepPhrase(steps) ?? "working"
        return phrase.prefix(1).uppercased() + phrase.dropFirst() + "…"
    }

    static func emptyText(canReply: Bool) -> String {
        canReply ? "No messages from this chat yet. Send one below to start." : "No messages from this chat yet."
    }
}
