import Foundation

// DESIGN.md 8.12, the Room as a chat: messages are bubbles, moments are compact centred lines. Every number and word the
// feed draws from here is pure and tested; the views only place them. Grouping itself (one sender, five minutes) is
// `RoomMessages.groupGap`; the feed stays append-only and id-stable.

public enum RoomBubblePlan {
    public enum Side: Equatable, Sendable { case leading, trailing }

    /// Mine on the right, everyone else (people and Ducks) on the left.
    public static func side(of author: RoomMessageAuthor) -> Side { author.kind == .me ? .trailing : .leading }

    /// Only a Duck or another person has an avatar and name above its first bubble; mine has neither.
    public static func showsAvatar(_ author: RoomMessageAuthor) -> Bool { author.kind != .me }

    /// Points between bubbles of one group, and between groups.
    public static let withinGroup: Double = 2
    public static let betweenGroups: Double = 14

    /// A bubble is at most this share of the reading column wide.
    public static let maxWidthShare: Double = 0.68
    /// Long text clamps here with "Show more" inside the bubble (measured, `RoomRowText.truncates`).
    public static let clampLines = 10
    public static let radius: Double = 14
    public static let smallRadius: Double = 4

    /// The last bubble of a group has the small corner on the sender's side (the tail); the others are round.
    public static func hasTail(index: Int, count: Int) -> Bool { index == count - 1 }

    /// The widest a bubble draws in a column `width` points wide.
    public static func maxWidth(column width: Double) -> Double { (width * maxWidthShare).rounded() }

    /// Under your own bubble: nothing once sent, "Sending…" while it goes, "Not sent" with Retry when it failed.
    public enum OwnState: Equatable, Sendable { case sent, sending, failed }
    public static func ownState(pending: Bool, failed: Bool) -> OwnState { failed ? .failed : (pending ? .sending : .sent) }
    public static func words(_ state: OwnState) -> String? {
        switch state { case .sent: nil; case .sending: "Sending\u{2026}"; case .failed: "Not sent" }
    }

    /// Reply to someone else's text bubble with one excerpt and an editable @mention in the Room draft.
    public static func reply(to author: RoomMessageAuthor, quoting text: String) -> RoomReply? {
        guard author.kind != .me else { return nil }
        let name = author.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        // When replying to a quoted reply, use the sender's words if available.
        guard !name.isEmpty, let line = lines.first(where: { !$0.hasPrefix(">") }) ?? lines.first else { return nil }
        return RoomReply(quote: RoomMessages.shorten(line, 90), mention: "@\(name)")
    }

    /// A Duck's note to a Duck wears a faint accent of the sender's colour on its left edge.
    public static func hasAccent(text: Bool, toDuck: Bool) -> Bool { text && toDuck }
}

public struct RoomReply: Equatable, Sendable {
    public let quote: String
    public let mention: String

    /// Preserve written text, replacing the previous reply's leading mention if it is still there.
    public func insertingMention(in draft: String, replacing previous: RoomReply?) -> String {
        var body = draft[...]
        if let previous, previous.hasLeadingMention(in: body) {
            body = body.dropFirst(previous.mention.count).drop(while: { $0 == " " })
        }
        if hasLeadingMention(in: body) { return body == mention ? mention + " " : String(body) }
        return "\(mention) \(body)"
    }

    /// The quote is context. Use a typographic @ inside it so quoted names do not trigger Room mentions.
    public func messageText(_ draft: String) -> String {
        let excerpt = quote.replacingOccurrences(of: "@", with: "＠")
        return "> “\(excerpt)”\n\n\(draft)"
    }

    private func hasLeadingMention(in draft: Substring) -> Bool {
        draft.hasPrefix(mention) && (draft.dropFirst(mention.count).first?.isWhitespace ?? true)
    }
}

public enum RoomMoment {
    /// "Ruby 2 finished \u{00B7} Released Greenroom 1.8.5\u{2026}": one line, never wrapped; the summary is cut to `limit`.
    public static func line(name: String, verb: String, summary: String, limit: Int = 90) -> String {
        let s = summary.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
        let cut = s.count <= limit ? s : String(s.prefix(limit - 1)) + "\u{2026}"
        return cut.isEmpty ? "\(name) \(verb)" : "\(name) \(verb) \u{00B7} \(cut)"
    }

    /// A run of one Duck's moments as one line: "Ruby 2 \u{00B7} 4 updates".
    public static func foldLabel(name: String, updates: Int) -> String {
        "\(name) \u{00B7} \(updates) \(updates == 1 ? "update" : "updates")"
    }
}

extension PondClick {
    /// A Duck's avatar or name in the Room, wherever it shows (message group, note sender, moment line, Task owner): the
    /// Duck's session first, else the Duck the name belongs to; nil for a person (their avatar opens nothing).
    public static func duck(session: String?, name: String?, threads: [RoomThread]) -> PondOpenTarget? {
        if let session, !session.isEmpty { return .duck(session) }
        guard let name, !name.isEmpty else { return nil }
        return threads.first { $0.duckName == name }.map { .duck($0.sessionId) }
    }

    /// The "\u{2192} Dot 2" receiver of a Duck's note.
    public static func receiver(of note: RoomHandoff, threads: [RoomThread]) -> PondOpenTarget? {
        duck(session: nil, name: note.to, threads: threads)
    }

    /// The sender of a note.
    public static func sender(of note: RoomHandoff, threads: [RoomThread]) -> PondOpenTarget? {
        duck(session: note.fromSessionId, name: note.from, threads: threads)
    }

    /// A moment line's Duck.
    public static func target(status: RoomStatusLine, threads: [RoomThread]) -> PondOpenTarget? {
        duck(session: status.sessionId, name: status.name, threads: threads)
    }

    /// A Task card's owner Duck (the one that has the Task).
    public static func owner(of task: RoomTaskCard) -> PondOpenTarget? { task.opens.map(PondOpenTarget.duck) }
}
