import Foundation

// DESIGN.md 8.12, the Room as flat rows (Slack or Cliq style): avatar, bold name, muted time, the text on the page with no
// box. Every number and word the feed draws from here is pure and tested; the views only place them. Grouping itself (one
// sender, five minutes) is `RoomMessages.groupGap`; the feed stays append-only and id-stable.

public enum RoomRowPlan {
    // MARK: Metrics (points; the mock-up's direction B)

    public static let avatar: Double = 36
    /// Between the avatar column and the text.
    public static let gutterGap: Double = 12
    /// A row's own padding above and below; two rows of one run sit this far apart twice over.
    public static let rowPad: Double = 2
    /// Extra room above the first row of a group (a new name).
    public static let groupLead: Double = 10
    /// The thin line that marks my own messages.
    public static let ownLineWidth: Double = 2
    public static let rowRadius: Double = 8
    public static let nameSize: Double = 14.5
    public static let timeSize: Double = 11
    /// Where every inline card (Task, question, canvas) starts: under the name, in the text column.
    public static var textInset: Double { avatar + gutterGap }

    // MARK: Who gets what

    /// Mine are marked only by the Pond-coloured line; the avatar and name stay like everyone's.
    public static func isOwn(_ author: RoomMessageAuthor) -> Bool { author.kind == .me }

    /// A group's first row carries the avatar, name and time; the rest of the run shows only its text (the time on hover).
    public static func showsHeader(index: Int) -> Bool { index == 0 }

    /// The mark under a Duck message the host wrote itself.
    public static let fallbackWords = "written by Squeak"
    public static func fallbackMark(for message: RoomMessage) -> String? { message.fallback ? fallbackWords : nil }

    // MARK: Long messages

    /// A message shows in full; only an unusually long one ends after this many lines with "Open in <name>'s chat".
    public static let longLines = 12
    /// Characters per line of the reading column (about 650 points of 14 point text); used to estimate wrapping without measuring
    /// (measuring made rows change height after they were drawn).
    public static let charsPerLine = 86

    /// Lines the text takes: each source line wraps, a blank line is a paragraph gap that counts as one.
    public static func estimatedLines(_ text: String) -> Int { lineCosts(text).reduce(0, +) }

    static func lineCosts(_ text: String) -> [Int] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map { l in
            let n = l.trimmingCharacters(in: .whitespaces).count
            return max(1, (n + charsPerLine - 1) / charsPerLine)
        }
    }

    public static func isLong(_ text: String) -> Bool { estimatedLines(text) > longLines }

    public struct Clip: Equatable, Sendable {
        public var shown: String
        public var clipped: Bool
    }

    /// The text to draw: all of it, or its first `longLines` lines (cut between lines, a code fence closed so the block still
    /// draws as code) when it is unusually long. Pure on the text, so a row never changes height after it is drawn.
    public static func clip(_ text: String) -> Clip {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isLong(t) else { return Clip(shown: t, clipped: false) }
        let lines = t.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let costs = lineCosts(t)
        var used = 0, keep = 0
        while keep < lines.count, used + costs[keep] <= longLines { used += costs[keep]; keep += 1 }
        if keep == 0 {
            // One enormous line: cut at a word.
            var cut = String(lines[0].prefix(longLines * charsPerLine))
            if let sp = cut.lastIndex(of: " ") { cut = String(cut[..<sp]) }
            return Clip(shown: cut + "\u{2026}", clipped: true)
        }
        var shown = Array(lines[..<keep])
        while let last = shown.last, last.trimmingCharacters(in: .whitespaces).isEmpty { shown.removeLast() }
        let fences = shown.filter { $0.trimmingCharacters(in: .whitespaces).hasPrefix("```") }.count
        if fences % 2 == 1 { shown.append("```") }
        return Clip(shown: shown.joined(separator: "\n"), clipped: true)
    }

    /// "Open in Kit's chat".
    public static func openLabel(name: String) -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Open in chat" : "Open in \(n)\u{2019}s chat"
    }

    // MARK: Hover actions

    public enum Action: String, Equatable, Sendable { case reply = "Reply", copy = "Copy", makeTask = "Make task" }

    /// Height every row with actions always reserves for its bar under the text, drawn or not (points): the feed never
    /// changes height as the pointer passes, and the bar never covers text.
    public static let barHeight: Double = 24
    /// Gap between the row's last line and its bar.
    public static let barGap: Double = 2
    /// A row with no action (nothing to Copy) reserves nothing; every other row reserves the bar's height at all times.
    public static func reservedBarHeight(actions: [Action]) -> Double { actions.isEmpty ? 0 : barHeight + barGap }
    /// The bar is drawn on hover or keyboard focus only; its space is reserved regardless.
    public static func barOpacity(hover: Bool, focusWithin: Bool) -> Double { hover || focusWithin ? 1 : 0 }

    /// The small bar under a row's text: Reply (never on my own), Copy, Make task (only where a Task can be made), in this order.
    public static func actions(for message: RoomMessage, text: String, canReply: Bool) -> [Action] {
        var out: [Action] = []
        if canReply, reply(to: message.author, quoting: text) != nil { out.append(.reply) }
        out.append(.copy)
        if message.canMakeTask, message.postId != nil { out.append(.makeTask) }
        return out
    }

    // MARK: Delivery

    /// Under your own row: nothing once sent, "Sending…" while it goes, "Not sent" with Retry when it failed.
    public enum OwnState: Equatable, Sendable { case sent, sending, failed }
    public static func ownState(pending: Bool, failed: Bool) -> OwnState { failed ? .failed : (pending ? .sending : .sent) }
    public static func words(_ state: OwnState) -> String? {
        switch state { case .sent: nil; case .sending: "Sending\u{2026}"; case .failed: "Not sent" }
    }

    /// Reply to someone else's message with one excerpt and an editable @mention in the Room draft.
    public static func reply(to author: RoomMessageAuthor, quoting text: String) -> RoomReply? {
        guard author.kind != .me else { return nil }
        let name = author.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let lines = text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        // When replying to a quoted reply, use the sender's words if available.
        guard !name.isEmpty, let line = lines.first(where: { !$0.hasPrefix(">") }) ?? lines.first else { return nil }
        return RoomReply(quote: RoomMessages.shorten(line, 90), mention: "@\(name)")
    }
}

/// "3 new" in the duck's yellow, once, before the first thing from someone else you have not seen. `seenAt` is when the Room was
/// last left (ms); nil (never opened) shows no divider. A group that straddles it is split there; the first part keeps its id.
public enum RoomUnread {
    public static func unseen(_ item: RoomItem, since seenAt: Int64) -> Int {
        switch item {
        case .group(let g): g.author.kind == .me ? 0 : g.messages.filter { $0.at > seenAt }.count
        case .system(let s): s.at > seenAt ? 1 : 0
        case .day, .unread: 0
        }
    }

    public static func insert(into items: [RoomItem], seenAt: Int64?) -> [RoomItem] {
        guard let seenAt, seenAt > 0 else { return items }
        guard let first = items.firstIndex(where: { unseen($0, since: seenAt) > 0 }) else { return items }
        var out = Array(items[..<first])
        var rest = Array(items[first...])
        if case .group(let g) = rest[0], let cut = g.messages.firstIndex(where: { $0.at > seenAt }), cut > 0 {
            var before = g; before.messages = Array(g.messages[..<cut])
            var after = g; after.messages = Array(g.messages[cut...])
            out.append(.group(before))
            rest[0] = .group(after)
        }
        let count = rest.reduce(0) { $0 + unseen($1, since: seenAt) }
        out.append(.unread(count: count))
        return out + rest
    }

    /// "3 new".
    public static func label(_ count: Int) -> String { "\(count) new" }

    /// The time the Room is read up to: the newest thing in it (ms), what to remember when it is left.
    public static func seenUpTo(_ items: [RoomItem]) -> Int64? { items.compactMap(\.at).max() }
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

    /// A Task card's Open: its Duck's chat at the turn the Task began in, else the chat.
    public static func open(task: RoomTaskCard) -> PondOpenTarget? {
        guard let duck = task.opens else { return nil }
        return task.opensTurn.map { .turn(duck: duck, turnId: $0) } ?? .duck(duck)
    }
}
