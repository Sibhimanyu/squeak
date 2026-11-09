import Foundation

// DESIGN.md §8.10, review in the Changes diff: a comment on one or more diff lines, collected in a tray and sent
// to the chat as one message (Conductor's review flow). Pure logic; the gutter and the tray are in the app.

public struct DiffComment: Identifiable, Equatable, Sendable {
    public var id: UUID
    public var path: String
    /// "12", "12-14", or "12 (removed)": the line numbers the message names.
    public var label: String
    public var quoted: [String]
    public var text: String
    /// The last line it sits on, to draw it under that line while the same diff is open.
    public var endNumber: Int?
    public var endRemoved: Bool

    public init(
        id: UUID = UUID(), path: String, label: String, quoted: [String], text: String, endNumber: Int? = nil, endRemoved: Bool = false
    ) {
        self.id = id; self.path = path; self.label = label; self.quoted = quoted; self.text = text
        self.endNumber = endNumber; self.endRemoved = endRemoved
    }
}

public enum DiffComments {
    /// A line a comment can sit on: code, not a hunk header or a "no newline" note.
    public static func isCommentable(_ line: DiffLine) -> Bool {
        line.kind == .added || line.kind == .removed || line.kind == .context
    }

    /// The indices a click on `to` selects when the gutter was first clicked at `anchor` (shift-click extends).
    public static func range(anchor: Int, to: Int) -> ClosedRange<Int> { min(anchor, to)...max(anchor, to) }

    /// A comment on these lines (hunk headers and notes inside the selection are skipped). Nil with no code line or
    /// no words.
    public static func make(path: String, lines: [DiffLine], text: String) -> DiffComment? {
        let code = lines.filter(isCommentable)
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, !words.isEmpty else { return nil }
        let last = code.last!
        return DiffComment(
            path: path, label: label(code), quoted: code.map(\.text), text: words,
            endNumber: last.newNumber ?? last.oldNumber, endRemoved: last.newNumber == nil)
    }

    /// The index of the line a comment is drawn under: its last line, found by number in this diff; nil when the
    /// diff no longer has it (the file moved on).
    public static func anchorIndex(of c: DiffComment, in lines: [DiffLine]) -> Int? {
        guard let n = c.endNumber else { return nil }
        return lines.firstIndex { l in
            isCommentable(l) && (c.endRemoved ? (l.newNumber == nil && l.oldNumber == n) : l.newNumber == n)
        }
    }

    /// The index of the line a host comment (file + one new-file line number) is drawn under; nil when this diff
    /// does not show that line.
    public static func anchorIndex(ofHost c: NativeComment, in lines: [DiffLine]) -> Int? {
        lines.firstIndex { isCommentable($0) && $0.newNumber == c.line }
    }

    /// The single line the host can store for a comment: its last new-file line. Nil for a comment on removed lines
    /// (the host numbers the file as it will be), which stays in the tray only.
    public static func hostLine(of c: DiffComment) -> Int? { c.endRemoved ? nil : c.endNumber }

    /// "12", "12-14" or "12 (removed)" for a selection, as the message names it ("?" when no line can be commented on).
    public static func rangeLabel(_ lines: [DiffLine]) -> String { label(lines.filter(isCommentable)) }

    /// New-file numbers when any line has one (the file as it will be), else the old numbers, marked as removed.
    static func label(_ code: [DiffLine]) -> String {
        let new = code.compactMap(\.newNumber)
        let numbers = new.isEmpty ? code.compactMap(\.oldNumber) : new
        guard let lo = numbers.min(), let hi = numbers.max() else { return "?" }
        let span = lo == hi ? "\(lo)" : "\(lo)-\(hi)"
        return new.isEmpty ? span + " (removed)" : span
    }

    static let maxQuotedLines = 8
    static let maxQuotedWidth = 200

    /// The one message "Send to chat" sends: every comment as `path:line`, the quoted code, then the words.
    public static func message(_ comments: [DiffComment]) -> String {
        guard !comments.isEmpty else { return "" }
        var out = [comments.count == 1 ? "Review comment on your changes:" : "Review comments on your changes:"]
        for c in comments {
            out.append("")
            out.append("\(c.path):\(c.label)")
            for line in c.quoted.prefix(maxQuotedLines) {
                let clipped = line.count > maxQuotedWidth ? String(line.prefix(maxQuotedWidth)) + "…" : line
                out.append("> " + clipped)
            }
            if c.quoted.count > maxQuotedLines { out.append("> … \(c.quoted.count - maxQuotedLines) more lines") }
            out.append(c.text)
        }
        return out.joined(separator: "\n")
    }
}

public struct DiffCommentTray: Equatable, Sendable {
    public private(set) var comments: [DiffComment] = []
    public init() {}

    public var isEmpty: Bool { comments.isEmpty }
    public var count: Int { comments.count }

    public mutating func add(_ c: DiffComment) { comments.append(c) }
    public mutating func remove(_ id: UUID) { comments.removeAll { $0.id == id } }
    public mutating func clear() { comments = [] }
    public func comments(in path: String) -> [DiffComment] { comments.filter { $0.path == path } }
    public var message: String { DiffComments.message(comments) }
}
