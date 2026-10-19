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

    init(id: UUID = UUID(), text: String, date: Date, answersTurn: String?, status: Status = .sent) {
        self.id = id; self.text = text; self.date = date; self.answersTurn = answersTurn; self.status = status
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
        case working(label: String)
        case empty(String)

        var id: String {
            switch self {
            case .agent: "agent"
            case .sent(let s): s.id.uuidString
            case .working: "working"
            case .empty: "empty"
            }
        }
    }

    /// A send with no reply this long after it stops counting as "starting", whatever the snapshot says.
    static let giveUp: TimeInterval = 600

    static func rows(
        session: PhoneSnapshot.Session, remembered: RememberedMessage?, sends: [ChatSend], now: Date = Date()
    ) -> [Row] {
        let working = session.state == "working"
        let current: String? = working ? nil : [session.message, session.detail].compactMap { $0 }.first { !$0.isEmpty }

        func replied(_ s: ChatSend) -> Bool {
            if now.timeIntervalSince(s.date) > giveUp, !working { return true }
            guard current != nil, !working else { return false }
            if s.answersTurn == nil { return (Age.date(session.lastActivityAt) ?? .distantPast) > s.date }
            return session.turnId != s.answersTurn
        }
        let awaiting = sends.filter {
            switch $0.status {
            case .refused: false
            default: !replied($0)
            }
        }
        let isWorking = working || (!awaiting.isEmpty && !session.needsYou && session.state != "error")

        let anchorTurn = isWorking ? remembered?.turnId : session.turnId
        func after(_ s: ChatSend) -> Bool {
            if awaiting.contains(where: { $0.id == s.id }) { return true }
            return s.answersTurn != nil && s.answersTurn == anchorTurn
        }
        /// "Queued" is true only while the agent is still on the turn the message waited behind;
        /// once that turn is over it has read it, so the line says "Sent". A steer stays "Steered".
        func settled(_ s: ChatSend) -> ChatSend {
            guard case .queued = s.status, !working else { return s }
            var copy = s
            copy.status = .sent
            return copy
        }
        var rows: [Row] = sends.filter { !after($0) }.map { .sent(settled($0)) }
        if isWorking {
            if let r = remembered { rows.append(.agent(text: r.text, atISO: r.atISO, muted: true)) }
        } else if let current {
            rows.append(.agent(text: current, atISO: session.lastActivityAt, muted: false))
        }
        rows += sends.filter(after).map { .sent(settled($0)) }
        if isWorking { rows.append(.working(label: workingLabel(session.activity?.steps ?? []))) }
        return rows.isEmpty ? [.empty(emptyText(canReply: Presentation.replyBlock(session) == nil))] : rows
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
