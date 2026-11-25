import Foundation

/// A Duck name as people see it: never with a digit ("Quill 2" is "Quill").
public enum RoomDuckName {
    public static func plain(_ name: String) -> String {
        let t = name.trimmingCharacters(in: .whitespaces)
        guard let r = t.range(of: #"\s+\d+$"#, options: .regularExpression) else { return t }
        let head = String(t[..<r.lowerBound])
        return head.isEmpty ? t : head
    }
}

/// How a Duck-to-Duck message reads in the Room: one group-chat line (the sender's summary, else the first sentences of the
/// message cut at a word end) with the receiver as an @mention at its start; the whole message waits behind "Show full message".
extension RoomHandoff {
    /// Most characters of the line when it has to be made from the message.
    public static let lineMax = 220

    /// The sender as shown (never numbered).
    public var senderName: String { RoomDuckName.plain(from) }

    /// "@Dot" for the receiver; a note to nobody in particular has no mention.
    public var mention: String? { to.map { "@" + RoomDuckName.plain($0) } }

    /// The whole message without a leading "@Dot " (the mention is drawn as a chip).
    public var plainBody: String {
        Self.stripMention((fullBody ?? body).trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The Room line: the summary when there is one, else the message's first two sentences, cut at a word end.
    public var line: String {
        if let s = summary?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty { return Self.stripMention(s) }
        return Self.firstSentences(Self.stripMention(body.trimmingCharacters(in: .whitespacesAndNewlines)), max: Self.lineMax)
    }

    /// The whole original message, when it says more than the line does; nil when the line is all of it.
    public var fullMessage: String? {
        let whole = plainBody
        return whole.isEmpty || Self.squash(whole) == Self.squash(line) ? nil : whole
    }

    public static func disclosureLabel(open: Bool) -> String { open ? "Hide full message" : "Show full message" }

    /// What a screen reader says: "Quill to Dot: ...".
    public var spoken: String { senderName + (to.map { " to " + RoomDuckName.plain($0) } ?? "") + ": " + line }

    static func stripMention(_ text: String) -> String {
        guard text.hasPrefix("@"), let r = text.range(of: #"^@\S+(?: \d+)?(?=\s)"#, options: .regularExpression) else { return text }
        return String(text[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func squash(_ t: String) -> String {
        t.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    static func firstSentences(_ text: String, max: Int) -> String {
        let flat = squash(text)
        var count = 0
        var end = flat.startIndex
        var i = flat.startIndex
        while i < flat.endIndex {
            let c = flat[i]
            let next = flat.index(after: i)
            if ".!?".contains(c), next == flat.endIndex || flat[next] == " " {
                count += 1
                end = next
                if count == 2 { break }
            }
            i = next
        }
        let picked = count == 0 ? flat : String(flat[..<end])
        guard picked.count > max else { return picked }
        let cut = String(picked.prefix(max - 1))
        let head = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
        return head.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-")) + "\u{2026}"
    }
}
