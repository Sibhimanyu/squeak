import Foundation
import SqueakCore

/// The Needs you page's decisions (DESIGN.md §8.4), as plain values: what each card says and which
/// controls it offers, how many cards are full, and where a send stands. Pure and free of UIKit so
/// `swift test` covers it. It only phrases the snapshot: whether a chat needs you, and what it asks, are
/// the daemon's words.
enum NeedsYou {
    /// What the chat waits for, which decides the card's controls.
    enum Kind: Equatable {
        /// A tool call to approve: only Conductor on the Mac can.
        case approval
        /// Held open inside Conductor with nothing the phone can read or answer.
        case blocked
        /// A plan to approve (ExitPlanMode).
        case plan
        /// An AskUserQuestion, answered with the question card.
        case question
        /// The agent's message ended on lettered options.
        case choices
        /// A finished chat that closed on a question for you.
        case asks
    }

    enum Control: Equatable {
        case choices, answerQuestion, plan, reply
        /// Says where to approve: the phone has no button for it.
        case approvalNote
        case openChat
    }

    struct Card: Equatable {
        let kind: Kind
        /// "needs approval", "needs an answer", "asks you".
        let stateWord: String
        /// The question as the card's heading; nil when its own control prints it (the question card).
        let heading: String?
        /// The start of the agent's last message, and whether more is behind "Show full message".
        let context: String?
        let full: String?
        let controls: [Control]
        var hasMore: Bool { full != nil && full != context }
    }

    static func card(for session: PhoneSnapshot.Session) -> Card {
        let kind = self.kind(of: session)
        let heading: String?
        switch kind {
        case .approval: heading = Presentation.firstLine(session.detail ?? session.message) ?? "Wants approval for a tool call."
        case .blocked: heading = Presentation.ask(session)
        case .question: heading = nil
        case .plan, .choices, .asks: heading = Presentation.ask(session)
        }
        let (context, full) = self.context(session, kind: kind, heading: heading)
        var controls: [Control] = []
        switch kind {
        case .approval, .blocked: controls = [.approvalNote]
        case .plan: controls = [.plan]
        case .question: controls = [.answerQuestion]
        case .choices: controls = [.choices]
        case .asks: controls = []
        }
        if Presentation.replyBlock(session) == nil { controls.append(.reply) }
        controls.append(.openChat)
        let word = kind == .asks ? "asks you" : kind == .plan ? "needs approval" : Presentation.status(session).text
        return Card(kind: kind, stateWord: word, heading: heading, context: context, full: full, controls: controls)
    }

    static func kind(of session: PhoneSnapshot.Session) -> Kind {
        if session.state == "awaiting_approval" { return .approval }
        if session.state == "awaiting_input" {
            guard let question = session.question else { return .blocked }
            return question.plan != nil ? .plan : .question
        }
        if session.state != "working", let choices = session.choices, !choices.options.isEmpty { return .choices }
        return .asks
    }

    /// The agent's message above its question: paragraphs up to about `limit` characters (cut at a sentence),
    /// and the whole message for "Show full message". The question itself and the lettered options are
    /// the card's own controls, so they are taken out of the prose.
    static func context(_ session: PhoneSnapshot.Session, kind: Kind, heading: String?, limit: Int = 200) -> (preview: String?, full: String?) {
        guard let message = session.message, !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return (nil, nil) }
        let choices = kind == .choices ? session.choices : nil
        var paragraphs = Presentation.read(message: message, choices: choices).before
        if choices != nil { paragraphs += Presentation.read(message: message, choices: choices).after }
        let asked = (heading ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        paragraphs = paragraphs.filter { paragraph in
            let bare = paragraph.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            return asked.isEmpty || !(bare == asked || bare.hasSuffix(asked) && bare.count < asked.count + 8)
        }
        // The agent's status line for an approval is the heading already.
        if kind == .approval || kind == .blocked { paragraphs = paragraphs.filter { Presentation.firstLine($0) != Presentation.firstLine(heading) } }
        guard !paragraphs.isEmpty else { return (nil, nil) }
        let full = paragraphs.joined(separator: "\n\n")
        var preview = ""
        for paragraph in paragraphs {
            if !preview.isEmpty, preview.count + paragraph.count > limit { break }
            preview += (preview.isEmpty ? "" : "\n\n") + paragraph
        }
        if preview.count > limit { preview = cut(preview, at: limit) }
        return (preview, full)
    }

    /// Cut at the last sentence end before `limit`, else the last space, and mark the cut.
    static func cut(_ text: String, at limit: Int) -> String {
        let head = String(text.prefix(limit))
        if let end = head.lastIndex(where: { ".!?".contains($0) }), head.distance(from: head.startIndex, to: end) > limit / 2 {
            return String(head[...end]) + " …"
        }
        if let space = head.lastIndex(of: " ") { return String(head[..<space]) + " …" }
        return head + "…"
    }

    /// The chats that wait on you, in the order the page shows them. The snapshot says who needs you;
    /// this only puts a tool call that nothing else can answer ahead of questions the phone can, and the one
    /// that has waited longest first. (The daemon sends no ranking of its own for this.)
    static func ordered(_ sessions: [PhoneSnapshot.Session]) -> [PhoneSnapshot.Session] {
        func rank(_ s: PhoneSnapshot.Session) -> Int { [.approval, .blocked].contains(kind(of: s)) ? 0 : 1 }
        func since(_ s: PhoneSnapshot.Session) -> Date { Age.date(s.lastActivityAt) ?? .distantFuture }
        return sessions.filter(\.needsYou).sorted { a, b in
            rank(a) != rank(b) ? rank(a) < rank(b) : since(a) < since(b)
        }
    }

    /// How many cards are full and how many are compact rows: one or two are all full; from three on
    /// the first two are full and the rest wait in rows.
    struct Layout: Equatable {
        let full: Int
        let compact: Int
        /// "3 more waiting"
        var moreLine: String? { compact > 0 ? "\(compact) more waiting" : nil }
    }

    static func layout(count: Int) -> Layout {
        Layout(full: min(max(count, 0), 2), compact: max(count - 2, 0))
    }

    /// Under the page's last card, and the empty page's hint: what else is going on.
    static func hint(_ sessions: [PhoneSnapshot.Session]) -> String {
        let working = sessions.filter { $0.state == "working" }.count
        return working > 0 ? "\(working) working" : "Nothing is running either."
    }

    /// Where the answer sent from this card stands. Only sends for the turn the card asks about count,
    /// so an earlier message never reads as this answer.
    enum Outcome: Equatable {
        case none
        case sending
        case sent
        /// Not sent, or unconfirmed: the line says which, and the send can be taken again or edited.
        case failed(line: String, sendId: UUID)

        var line: String? {
            switch self {
            case .none: nil
            case .sending: "Sending…"
            case .sent: "Sent · waiting for the agent"
            case .failed(let line, _): line
            }
        }
    }

    static func outcome(of sends: [ChatSend], for session: PhoneSnapshot.Session) -> Outcome {
        guard let send = sends.last(where: { $0.answersTurn == session.turnId }) else { return .none }
        switch send.status {
        case .sending: return .sending
        case .refused, .notConfirmed: return .failed(line: send.status.line, sendId: send.id)
        case .sent, .queued, .steered, .read: return .sent
        }
    }
}
