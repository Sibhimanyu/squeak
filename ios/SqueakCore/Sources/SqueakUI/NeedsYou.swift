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
        /// Words for VoiceOver only, never drawn: "Waiting for your approval", "Waiting for your answer", "Plan ready for your review".
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
        let word = kind == .asks ? "Waiting for your answer" : kind == .plan ? "Plan ready for your review" : Presentation.status(session).text
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
        // A question card draws the question and its options itself, so the same turn's lettered block is left out
        // of the preview (the whole message is still one tap away).
        let choices = kind == .choices || kind == .question ? session.choices : nil
        var paragraphs = Presentation.read(message: message, choices: choices).before
        if kind == .choices, choices != nil { paragraphs += Presentation.read(message: message, choices: choices).after }
        let asked = ([heading ?? ""] + (kind == .question ? session.question?.questions.map(\.question) ?? [] : []))
            .map { $0.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        paragraphs = paragraphs.filter { paragraph in
            let bare = paragraph.replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespacesAndNewlines)
            return !asked.contains { bare == $0 || bare.hasSuffix($0) && bare.count < $0.count + 8 }
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

    /// The chats that wait on you, newest first by last activity (the house rule: every list is newest
    /// first; this page is where urgency lives, not the sort order).
    static func ordered(_ sessions: [PhoneSnapshot.Session]) -> [PhoneSnapshot.Session] {
        Presentation.newestFirst(sessions.filter(\.needsYou))
    }

    /// One thing on the page: a chat, or a film (RasanAI) waiting on its call. A film has no chat of its own on this
    /// page: the director's session it names is dropped, since the film's card stands for it.
    enum Entry: Equatable, Identifiable {
        case session(PhoneSnapshot.Session)
        case film(PhoneFilm)

        var id: String {
            switch self {
            case .session(let session): session.key
            case .film(let film): film.id
            }
        }
        var date: Date? {
            switch self {
            case .session(let session): Age.date(session.lastActivityAt)
            case .film(let film): Age.date(film.updatedAt)
            }
        }
    }

    /// Films waiting on a call, newest first.
    static func waitingFilms(_ films: [PhoneFilm]) -> [PhoneFilm] {
        films.filter(\.waitingOnYou).sorted { a, b in
            let x = Age.date(a.updatedAt), y = Age.date(b.updatedAt)
            if let x, let y, x != y { return x > y }
            return a.title < b.title
        }
    }

    /// Everything that waits on you, newest first by last activity: chats and films together.
    static func entries(sessions: [PhoneSnapshot.Session], films: [PhoneFilm]) -> [Entry] {
        let waiting = waitingFilms(films)
        let stood = Set(waiting.compactMap(\.sessionKey))
        let all = sessions.filter(\.needsYou).filter { !stood.contains($0.key) }.map(Entry.session) + waiting.map(Entry.film)
        return all.sorted { a, b in
            switch (a.date, b.date) {
            case let (x?, y?) where x != y: return x > y
            case (nil, _?): return false
            case (_?, nil): return true
            default: return a.id < b.id
            }
        }
    }

    /// The Needs you tab's badge.
    static func count(sessions: [PhoneSnapshot.Session], films: [PhoneFilm]) -> Int {
        entries(sessions: sessions, films: films).count
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

    /// What else is going on, under the decisions: chats at work (never counted in the badge) and, only when
    /// nothing is blocked, the few chats that finished in the last 24 hours, newest first.
    struct Context: Equatable {
        var running: [PhoneSnapshot.Session]
        var recent: [PhoneSnapshot.Session]
    }

    static func context(sessions: [PhoneSnapshot.Session], decisions: Int, now: Date = Date(), recentLimit: Int = 4) -> Context {
        let running = Presentation.newestFirst(sessions.filter { Presentation.inFilter($0, .working) })
        guard decisions == 0 else { return Context(running: running, recent: []) }
        let day: TimeInterval = 24 * 3600
        let finished = sessions.filter { session in
            guard Presentation.inFilter(session, .done), let at = Age.date(session.lastActivityAt) else { return false }
            return now.timeIntervalSince(at) <= day
        }
        return Context(running: running, recent: Array(Presentation.newestFirst(finished).prefix(recentLimit)))
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
        case .sent, .queued, .steered, .read, .turnEnded: return .sent
        }
    }

    /// The status line at the top of a card: where the answer stands, in one place for every control.
    struct Receipt: Equatable {
        enum Phase: Equatable { case sending, sent, failed }
        let phase: Phase
        /// "Sending…", the failure's own words.
        let line: String
        /// Only a failed send from the outbox has one: Send again and Edit act on it.
        let sendId: UUID?
        /// What was sent, clipped to one line.
        let summary: String?

        /// What the card shows: once sent the body collapses to this under the header.
        var display: String {
            guard phase == .sent else { return line }
            guard let summary, !summary.isEmpty else { return "Sent" }
            return "Sent · \(summary)"
        }
        /// A sent card keeps only the header and this line, until the Mac says the chat no longer needs you.
        var collapsesBody: Bool { phase == .sent }
    }

    /// One line, whitespace folded, at most `limit` characters with an ellipsis.
    static func clip(_ text: String, to limit: Int = 60) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > limit else { return flat }
        return String(flat.prefix(limit)).trimmingCharacters(in: .whitespaces) + "…"
    }

    /// The receipt for the answer sent from this card (outbox), nil when nothing was sent for this turn.
    static func receipt(of sends: [ChatSend], for session: PhoneSnapshot.Session) -> Receipt? {
        let summary = sends.last(where: { $0.answersTurn == session.turnId }).map { clip($0.text) }
        switch outcome(of: sends, for: session) {
        case .none: return nil
        case .sending: return Receipt(phase: .sending, line: "Sending…", sendId: nil, summary: summary)
        case .sent: return Receipt(phase: .sent, line: "Sent · waiting for the agent", sendId: nil, summary: summary)
        case .failed(let line, let id): return Receipt(phase: .failed, line: line, sendId: id, summary: summary)
        }
    }

    /// The text of the send in flight for this turn, so the tapped option can show the spinner.
    static func sendingText(of sends: [ChatSend], for session: PhoneSnapshot.Session) -> String? {
        guard outcome(of: sends, for: session) == .sending else { return nil }
        return sends.last(where: { $0.answersTurn == session.turnId })?.text
    }
}
