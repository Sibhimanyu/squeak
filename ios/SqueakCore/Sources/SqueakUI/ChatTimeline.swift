import Foundation
import SqueakCore

/// A message this phone sent, kept in memory per session. It is on screen the moment you send it
/// ("Sending…", then "Sent", or why it was refused) and stays after the agent's reply arrives.
/// A delivery state shown as a glyph under a sent message (DESIGN.md §8.5).
enum DeliveryMark: Equatable {
    case sending, sent, read
}

struct ChatSend: Identifiable, Equatable {
    enum Status: Equatable {
        case sending, sent
        /// The agent was mid-turn and reads it once the turn ends. `steerUnavailable` when steering was
        /// asked for but this chat's route cannot do it, so it was queued instead.
        case queued(agent: String, steerUnavailable: Bool)
        /// Went into the turn in progress.
        case steered
        /// Neither delivered nor refused: the Mac could not prove it arrived, or never answered. It may be in
        /// the chat. Never shown as sent, and never sent again by the app on its own.
        case notConfirmed
        /// It did not go through and nothing started; `String` is why. Its text is kept for Send again or Edit.
        case refused(String)
        /// The agent has it: its turn started from it, it shows in the turn, or it left the queue.
        /// Only ever worked out for display (`ChatTimeline.receipt`), never stored.
        case read(agent: String)
        /// The Mac has it, yet the turn it started ended without an answer after it (an error, a stop, nothing said).
        /// Only ever worked out for display, never stored.
        case turnEnded

        /// The one line under a "You" bubble, muted: sent, queued, steered or not sent.
        var line: String {
            switch self {
            case .sending: "Sending…"
            case .sent: "Sent"
            case .queued(let agent, let unavailable):
                unavailable ? "Queued · \(agent) reads it after this turn (steering isn't available here)"
                    : "Queued · \(agent) reads it after this turn"
            case .steered: "Steered into the current turn"
            case .notConfirmed: "Couldn't confirm it arrived. Check the chat before sending again."
            case .refused(let why): "Not sent. Nothing started. \(Self.sentence(why))"
            case .read(let agent): "Read by \(agent)"
            case .turnEnded: "Turn ended"
            }
        }

        /// The small mark under a "You" bubble in place of words, for the three states that need no explaining:
        /// a clock while it goes, one check once the Mac has it, two once the agent does.
        var mark: DeliveryMark? {
            switch self {
            case .sending: .sending
            case .sent: .sent
            case .read: .read
            default: nil
            }
        }

        /// The words shown under the bubble: none where a mark says it, short where the state is plain, and the
        /// full sentence for anything that went wrong (a problem needs its reason, never a glyph).
        var visibleLine: String? {
            switch self {
            case .sending, .sent, .read: nil
            case .queued(_, let unavailable): unavailable ? "Queued · steering isn't available here" : "Queued"
            default: line
            }
        }

        /// Waiting for the agent to reach it (queued mid-turn): drawn lighter until it is read, as Conductor does.
        var waitingToBeRead: Bool { if case .queued = self { true } else { false } }

        /// The line under a steer: when it went into the turn (the phone's own clock) and whether the agent has
        /// it. A steer typed on the Mac has no time of its own here, so it says only what happened.
        /// Anything that is not a landed steer (sending, refused) keeps its ordinary line.
        func steerLine(at date: Date?) -> String {
            let head = "Steered" + (date.map { " at " + $0.formatted(date: .omitted, time: .shortened) } ?? "")
            switch self {
            case .steered: return head
            case .read(let agent): return "\(head) · Read by \(agent)"
            case .turnEnded: return "\(head) · Turn ended"
            default: return line
            }
        }

        /// The Mac's reason as a sentence of its own.
        static func sentence(_ why: String) -> String {
            let t = why.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let first = t.first else { return "" }
            let s = first.uppercased() + t.dropFirst()
            return s.hasSuffix(".") || s.hasSuffix("!") || s.hasSuffix("?") ? s : s + "."
        }

        var isRefused: Bool { if case .refused = self { true } else { false } }

        /// Delivered, or possibly delivered: a user entry just after it may be it.
        var arrivedOrPlausible: Bool {
            switch self {
            case .sending, .refused: false
            default: true
            }
        }

        /// The Mac said it queued it.
        var isQueued: Bool {
            if case .queued = self { true } else { false }
        }

        /// A send that did not go through, or that nobody can vouch for: it offers Send again and Edit.
        var failed: Bool {
            switch self {
            case .refused, .notConfirmed: true
            default: false
            }
        }

        /// What a bubble says once the Mac has answered: sent only when the Mac says it put it in the chat,
        /// "couldn't confirm" when it could not prove that, and "not sent" otherwise, with its reason.
        static func verdict(_ result: CommandResult, agent: String) -> Status {
            if result.sent { return delivered(result, agent: agent) }
            if result.unconfirmed { return .notConfirmed }
            return .refused(result.reason ?? "your Mac refused that reply.")
        }

        /// What a bubble says when the Mac never answered. `withdrawn`: the command was taken back off the
        /// channel, so it can never run and nothing started. Otherwise nothing is known, and it says so.
        static func silence(withdrawn: Bool) -> Status {
            withdrawn ? .refused("your Mac didn't pick it up (is Squeak running there?), so the message was taken back.") : .notConfirmed
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
    var date: Date
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
    /// The channel command carrying it, once there is one.
    var commandId: String?
    /// When it was first sent: `date` moves on when it is sent again, and an earlier try may have arrived.
    var origin: Date

    init(id: UUID = UUID(), text: String, date: Date, answersTurn: String?, status: Status = .sent,
         messageId: String = UUID().uuidString.lowercased(), mode: ReplyMode = .queue, queuedBehindTurn: Bool = false) {
        self.id = id; self.text = text; self.date = date; self.origin = date; self.answersTurn = answersTurn; self.status = status
        self.messageId = messageId; self.mode = mode; self.queuedBehindTurn = queuedBehindTurn
    }

    var isSteer: Bool { mode == .steer }
}

/// One step of a turn as the chat shows it: the snapshot's or the live turn's, the same shape.
/// `you` is a message put into the turn while it ran (a steer).
struct TurnStep: Hashable {
    let kind: String
    let text: String
    /// When the Mac saw the step, if it said. Not part of what a step is: two reads of one step are equal.
    var at: Date? = nil

    static func == (a: TurnStep, b: TurnStep) -> Bool { a.kind == b.kind && a.text == b.text }
    func hash(into h: inout Hasher) { h.combine(kind); h.combine(text) }
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
        case .refused, .sent, .steered, .read, .turnEnded: return false
        case .notConfirmed:
            // Not known to have arrived, so it is shown as a failure, unless Conductor's own queue lists it.
            return live?.queue?.contains(where: { $0.id == send.messageId }) ?? false
        case .sending, .queued: break
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
            // The Mac's own "queued" answer is enough to steer or delete it by its id, before its queue list shows it
            // (and when it cannot list the queue at all): the Mac answers why if it cannot ("already went").
            // While the send is still going out it only shows "Queuing…".
            let accepted = $0.status.isQueued
            return Card(id: $0.messageId, text: $0.text, pending: $0.status == .sending || (live?.queue != nil && !accepted),
                        actionable: accepted || (live?.queue == nil && $0.status != .sending))
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
        /// The agent's work between two messages, counted. `messageId` is the message it sits before, which the row
        /// asks the Mac for the steps with (nil from an older Mac: the row is plain).
        case worked(id: String, steps: Int, messageId: String? = nil)
        case empty(String)

        var id: String {
            switch self {
            case .agent: "agent"
            case .sent(let s): s.id.uuidString
            case .steer(let id, _, _): id
            case .folded(let id, _): id
            case .working: "working"
            case .history(let id, _, _, _): id
            case .worked(let id, _, _): id
            case .empty: "empty"
            }
        }
    }

    /// A send that has not made the Mac report the agent working this long after it stops counting
    /// as "starting": the Mac's word wins. Streamed, a turn that starts shows as working within a
    /// second or two, so a send still not answered after this has not started anything. (It was ten
    /// minutes, and a chat whose turn had ended said "Starting…" inside while the list said done.)
    static let giveUp: TimeInterval = 90
    /// How long a chat must rest before a steer nobody confirmed counts as answered.
    static let idleHold: TimeInterval = 3

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
        live: LiveTurn? = nil, cachedHistory: [LiveTurn.HistoryEntry]? = nil, now: Date = Date(),
        idleFor: TimeInterval? = nil, heldSteps: [LiveTurn.Step]? = nil, offset: TimeInterval = 0
    ) -> [Row] {
        /// A time this phone stamped, on the Mac's clock: what history and steps are stamped with.
        func onMac(_ d: Date) -> Date { Self.mac(d, offset) }
        let working = session.state == "working"
        let live = live?.key == session.key ? live : nil
        let current: String? = working ? nil : [session.message, session.detail].compactMap { $0 }.first { !$0.isEmpty }
        // A message nobody could confirm that the chat's own history now shows did arrive.
        let held = firstNonEmpty(ChatHistoryState.overlay(cachedHistory, live?.history))
        // A send that failed long ago is settled history, not something to keep showing.
        let sendsKept = allSends.filter { !($0.status.failed && now.timeIntervalSince($0.origin) > failedKeep) }
        let history = withLastUser(held, session: session, sends: sendsKept, offset: offset)
        let proven: [ChatSend] = sendsKept.map { send in
            guard case .notConfirmed = send.status, arrived(send, in: history, offset: offset) || arrivedByTime(send, in: history, offset: offset) else { return send }
            var copy = send
            copy.status = .sent
            return copy
        }
        // Queued messages wait above the composer, not here.
        let sends = proven.filter { !ChatQueue.isQueued($0, session: session, live: live, now: now) }

        let steps = turnSteps(session: session, live: live, held: heldSteps)

        /// A steer the chat has moved past: a real message of the person's came after it, or the agent spoke after it
        /// in a later turn. It is history then, in its place by time, never "waiting to be read" at the bottom.
        /// Needs no rest: a chat that works nearly nonstop (background workers) never shows `!working`.
        func superseded(_ s: ChatSend) -> Bool {
            guard s.isSteer else { return false }
            // The transcript shows it inside the turn: the steer row comes from that step.
            if steps.contains(where: { $0.kind == "you" && same($0.text, s.text) }) { return false }
            if sends.contains(where: { $0.date > s.date && !$0.isSteer && startedTurn($0) }) { return true }
            // Only the chat moving on to another turn ends it: a message of the person's typed at the laptop in the
            // same turn (before this one was delivered) leaves this one waiting, and so does the agent's own notes.
            let laterTurn = s.answersTurn == nil || session.turnId != s.answersTurn
            guard laterTurn else { return false }
            let after = onMac(s.date).addingTimeInterval(1)
            return history?.contains { entry in
                guard let at = entry.date, at > after else { return false }
                if entry.role == "user" { return !same(entry.text, s.text) && !same(s.text, entry.text) && !sends.contains { $0.isSteer && same(entry.text, $0.text) } }
                return true
            } ?? false
        }
        func replied(_ s: ChatSend) -> Bool {
            if superseded(s) { return true }
            if now.timeIntervalSince(s.date) > giveUp, !working { return true }
            // A later message of this phone's own began a turn, so the turn this one started is over: with a
            // queue, the next turn follows the last at once and the chat may never be seen resting.
            if !s.isSteer, sends.contains(where: { $0.date > s.date && !$0.isSteer && startedTurn($0) }) { return true }
            // Between the short turns of a fan-out the chat flips idle for a moment: a steer is let go only after
            // the chat has rested for `idleHold` (when the caller tracks it), never on one tick.
            if s.isSteer, !working, let idleFor, idleFor < idleHold { return false }
            guard current != nil, !working else { return false }
            if s.answersTurn == nil { return (Age.date(session.lastActivityAt) ?? .distantPast) > onMac(s.date) }
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
            // A failure started nothing: no "Starting…" row under it.
            case .refused, .notConfirmed: false
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
        /// "Sent" says the Mac has it; "Read by Claude" says the agent does. "Queued" holds while the
        /// agent is still on the turn the message waited behind.
        func settled(_ s: ChatSend) -> ChatSend {
            var copy = s
            if read(s) { copy.status = .read(agent: agentName) } else if case .queued = s.status, !working { copy.status = .sent }
            // Replied to, yet no answer after it: the turn ended, so "Sent" must not stand forever.
            if replied(s), !read(s) {
                switch copy.status {
                case .sent, .queued, .steered: copy.status = .turnEnded
                default: break
                }
            }
            return copy
        }
        func read(_ s: ChatSend) -> Bool {
            switch s.status {
            case .sent, .queued, .steered: break
            default: return false
            }
            // The agent answered after it.
            if !working, current != nil {
                if s.answersTurn == nil { return (Age.date(session.lastActivityAt) ?? .distantPast) > onMac(s.date) }
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
        let pinned = Set(awaiting.map(\.id))
        // What is in the turn already, by its words and when: an older message with the same words is still history.
        let inTurn = steps.filter { $0.kind == "you" }.map { SteerText(text: $0.text, at: $0.at, window: -stepMatch...stepMatch) }
            + steers.map { SteerText(text: $0.text, at: onMac($0.date), window: -5...arrivalWindow) }
        rows = merged(history, tail: rows, steerTexts: inTurn, isWorking: isWorking, pinned: pinned, offset: offset)
        if isWorking {
            let output = history?.filter { $0.role != "user" }.compactMap(\.date).max()
            rows += turn(steps: steps, steers: steers.map(settled), truncated: total > steps.count, total: total, agentName: agentName, newestOutput: output, offset: offset)
            if session.compacting == true, let last = rows.indices.last, case .working(_, let shown) = rows[last] {
                rows[last] = .working(label: "Compacting the conversation…", steps: shown)
            }
        }
        return rows.isEmpty ? [.empty(emptyText(canReply: Presentation.replyBlock(session) == nil))] : rows
    }

    /// The chat's history has this message as a user entry written at or after it was sent.
    static func arrived(_ send: ChatSend, in history: [LiveTurn.HistoryEntry]?, offset: TimeInterval = 0) -> Bool {
        guard let history else { return false }
        return history.contains { entry in
            guard entry.role == "user", same(entry.text, send.text) || same(send.text, entry.text) else { return false }
            guard let at = entry.at.flatMap(Age.date) else { return false }
            return at >= mac(send.origin, offset).addingTimeInterval(-5)
        }
    }

    /// A failed send is dropped from the chat after this long.
    static let failedKeep: TimeInterval = 24 * 60 * 60
    /// The Mac writes a phone's message into the chat within seconds; its words may differ (a brief in front,
    /// attachments, a clip), so a user entry this soon after the send is plausibly it.
    static let arrivalWindow: TimeInterval = 90

    /// A user entry of the history written just after the send, whatever its words (see `arrivalWindow`).
    static func timeMatch(_ entry: LiveTurn.HistoryEntry, _ send: ChatSend, offset: TimeInterval = 0) -> Bool {
        guard entry.role == "user", let at = entry.date else { return false }
        let sent = mac(send.origin, offset)
        return at >= sent.addingTimeInterval(-5) && at <= sent.addingTimeInterval(arrivalWindow)
    }

    static func arrivedByTime(_ send: ChatSend, in history: [LiveTurn.HistoryEntry]?, offset: TimeInterval = 0) -> Bool {
        history?.contains { timeMatch($0, send, offset: offset) } ?? false
    }

    /// A time this phone stamped, on the Mac's clock. `offset` is how far ahead of the Mac this phone runs
    /// (`ClockSkew`): the history and the steps carry the Mac's times, the sends the phone's own.
    static func mac(_ phone: Date, _ offset: TimeInterval) -> Date { phone.addingTimeInterval(-offset) }

    /// How close a step's stamp and its history entry's must be for them to be the same message.
    static let stepMatch: TimeInterval = 30

    /// A message already in the turn: its words, and when it happened on the Mac's clock where that is known.
    struct SteerText: Equatable {
        let text: String
        let at: Date?
        /// How far a history entry's time may lie from `at` (entry minus `at`) and still be this message.
        let window: ClosedRange<TimeInterval>

        init(text: String, at: Date? = nil, window: ClosedRange<TimeInterval> = 0...0) { self.text = text; self.at = at; self.window = window }

        /// An older message with the same words is not it: with a time on both, the two must be close.
        func matches(_ entry: LiveTurn.HistoryEntry) -> Bool {
            guard ChatTimeline.same(entry.text, text) || ChatTimeline.same(text, entry.text) else { return false }
            guard let at, let when = entry.date else { return true }
            return window.contains(when.timeIntervalSince(at))
        }
    }

    /// An answer typed at the laptop: the newest user message the Mac reports, when neither this phone's own
    /// sends nor the history already show it. It joins the history, in its place by time.
    static func withLastUser(_ history: [LiveTurn.HistoryEntry]?, session: PhoneSnapshot.Session, sends: [ChatSend], offset: TimeInterval = 0) -> [LiveTurn.HistoryEntry]? {
        guard let last = session.lastUser, !last.text.isEmpty else { return history }
        let at = last.at.flatMap(Age.date)
        // This phone's own message (its words, or sent when the Mac wrote it).
        if sends.contains(where: { s in
            if s.status.isRefused { return false }
            if same(last.text, s.text) || same(s.text, last.text) { return true }
            if let at { let sent = mac(s.origin, offset); return at >= sent.addingTimeInterval(-5) && at <= sent.addingTimeInterval(arrivalWindow) }
            return false
        }) { return history }
        let entries = history ?? []
        if let newest = entries.last(where: { $0.role == "user" }), same(last.text, newest.text) || same(newest.text, last.text) {
            guard let a = at, let b = newest.date else { return history }
            if abs(a.timeIntervalSince(b)) < 120 { return history }
        }
        guard let at else { return entries.isEmpty ? [.init(role: "user", text: last.text)] : history }
        let entry = LiveTurn.HistoryEntry(role: "user", text: last.text, at: last.at)
        var out = entries
        out.insert(entry, at: out.firstIndex { ($0.date ?? .distantPast) > at } ?? out.endIndex)
        return out
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
    static func merged(_ history: [LiveTurn.HistoryEntry]?, tail: [Row], steerTexts: [SteerText], isWorking: Bool, pinned: Set<UUID> = [], offset: TimeInterval = 0) -> [Row] {
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
                entry.role == "user" && !steerTexts.contains { $0.matches(entry) }
            }
            if let lastUser { cut = history[lastUser...].firstIndex { $0.role != "user" } ?? history.count }
        }
        // A send whose own words are in the history keeps them: no entry may be matched to it by time instead.
        let wordsShown: Set<UUID> = Set(tail.compactMap { row in
            guard case .sent(let s) = row,
                  history.contains(where: { $0.role == "user" && (same($0.text, s.text) || same(s.text, $0.text)) }) else { return nil }
            return s.id
        })
        var out: [Row] = []
        /// When each row happened, where it is known: what an unplaced send is ordered against.
        var times: [Date?] = []
        func emit(_ row: Row, _ at: Date?) { out.append(row); times.append(at) }
        var seen: [String: Int] = [:]
        for (i, entry) in history.enumerated() {
            let fromUser = entry.role == "user"
            if i >= cut, !fromUser { continue }
            if fromUser, steerTexts.contains(where: { $0.matches(entry) }) { continue }
            let work: Row? = (entry.workBefore ?? 0) > 0 ? .worked(id: "w-\(stableID(entry, &seen))", steps: entry.workBefore!, messageId: entry.id) : nil
            let when = entry.date
            if fromUser {
                if let work { emit(work, nil) }
                let byWords = take({ if case .sent(let s) = $0 { same(entry.text, s.text) || same(s.text, entry.text) } else { false } })
                let byTime = byWords ?? take({
                    guard case .sent(let s) = $0, !wordsShown.contains(s.id), s.status.arrivedOrPlausible else { return false }
                    return timeMatch(entry, s, offset: offset)
                })
                if let m = byTime {
                    emit(tail[m], when)
                } else {
                    emit(.history(id: stableID(entry, &seen), fromUser: true, text: entry.text, atISO: entry.at), when)
                }
            } else {
                if let m = take({ if case .agent(let t, _, _) = $0 { same(entry.text, t) || same(t, entry.text) } else { false } }) {
                    // The finished turn's folded steps sit just before its answer: they stand in for the count.
                    if m > 0, case .folded = tail[m - 1], !used.contains(m - 1) {
                        used.insert(m - 1)
                        emit(tail[m - 1], nil)
                    } else if let work { emit(work, nil) }
                    emit(tail[m], when)
                } else {
                    if let work { emit(work, nil) }
                    emit(.history(id: stableID(entry, &seen), fromUser: false, text: entry.text, atISO: entry.at), when)
                }
            }
        }
        var unplaced: [ChatSend] = []
        for (i, row) in tail.enumerated() where !used.contains(i) {
            // A muted earlier answer the history has under other words: the history's copy stands.
            if case .agent(_, _, true) = row { continue }
            switch row {
            case .sent(let s) where !pinned.contains(s.id): unplaced.append(s)
            case .agent(_, let atISO, _): emit(row, Age.date(atISO))
            case .sent(let s): emit(row, mac(s.date, offset))
            default: emit(row, nil)
            }
        }
        // A send the history does not show goes where it happened: before the first message that came after it
        // (and the work that led to that message). Only a send newer than everything is last.
        for s in unplaced.sorted(by: { $0.date < $1.date }) {
            let newest = times.compactMap { $0 }.max()
            let sentAt = mac(s.date, offset)
            guard let newest, sentAt.addingTimeInterval(3) < newest,
                  var at = times.firstIndex(where: { ($0 ?? .distantPast) > sentAt }) else {
                emit(.sent(s), sentAt)
                continue
            }
            while at > 0 {
                if case .worked = out[at - 1] { at -= 1 } else if case .folded = out[at - 1] { at -= 1 } else { break }
            }
            out.insert(.sent(s), at: at)
            times.insert(sentAt, at: at)
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
    static func turnSteps(session: PhoneSnapshot.Session, live: LiveTurn?, held: [LiveTurn.Step]? = nil) -> [TurnStep] {
        func map(_ steps: [LiveTurn.Step]) -> [TurnStep] { steps.map { TurnStep(kind: $0.kind, text: $0.text, at: $0.at.flatMap(Age.date)) } }
        if let live, live.working, !live.steps.isEmpty { return map(live.steps) }
        // The live document blinked (not working, or empty) while the chat still works: hold, never swap in the snapshot's six.
        if let held, !held.isEmpty, session.state == "working" { return map(held) }
        return (session.activity?.steps ?? []).map { TurnStep(kind: $0.kind, text: $0.text) }
    }

    /// The turn in parts: each steer where it landed, the steps before it folded, the live part last.
    /// A steer the Mac has not reported yet goes at the end, the agent still to read it.
    static func turn(steps: [TurnStep], steers: [ChatSend], truncated: Bool, total: Int = 0, agentName: String = "the agent", newestOutput: Date? = nil, offset: TimeInterval = 0) -> [Row] {
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
            rows += early.map { .steer(id: $0.id.uuidString, text: $0.text, line: $0.status.steerLine(at: $0.date)) }
            unmatched.removeAll { s in early.contains { $0.id == s.id } }
        }
        for (i, you) in yous.enumerated() {
            if !segments[i].isEmpty { rows.append(.folded(id: "part-\(i)", steps: segments[i])) }
            if let mine = unmatched.firstIndex(where: { same(you, $0.text) }) {
                let s = unmatched.remove(at: mine)
                rows.append(.steer(id: s.id.uuidString, text: s.text, line: s.status.steerLine(at: s.date)))
            } else {
                // Typed on the Mac: in the transcript, so the agent has it.
                rows.append(.steer(id: "you-\(i)", text: you, line: ChatSend.Status.read(agent: agentName).steerLine(at: nil)))
            }
        }
        var live = segments[segments.count - 1]
        var reading = false
        if !unmatched.isEmpty {
            // Steps the Mac stamped before the newest steer came before it: fold them above the steer. A step that
            // is newer, or has no stamp, stays live, so steps never vanish because a steer is not yet reported.
            let newest = mac(unmatched.map(\.date).max() ?? .distantPast, offset)
            var split = 0
            while split < live.count, let at = live[split].at, at <= newest { split += 1 }
            if split > 0 { rows.append(.folded(id: "part-\(yous.count)", steps: Array(live[..<split]))) }
            live = Array(live[split...])
            rows += unmatched.map { .steer(id: $0.id.uuidString, text: $0.text, line: $0.status.steerLine(at: $0.date)) }
            // Never "reading" a steer the agent has already spoken after.
            reading = live.isEmpty && !(newestOutput.map { $0 > newest } ?? false)
        }
        let steered = !yous.isEmpty || !unmatched.isEmpty
        let waiting = reading || (unmatched.isEmpty && live.isEmpty && steered)
        rows.append(.working(label: waiting ? "Reading your message…" : (live.isEmpty && !unmatched.isEmpty ? "Working…" : workingLabel(turn: live)), steps: live))
        return rows
    }

    /// The Mac's copy of a message is whitespace-flattened and may be clipped with "…".
    static func same(_ reported: String, _ sent: String) -> Bool {
        func flat(_ t: String) -> String { PhotoAttachment.plainMentions(t).split(whereSeparator: \.isWhitespace).joined(separator: " ") }
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
