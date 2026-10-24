import Foundation

/// Whether a transcript row is the message we sent. The transcript's copy of a prompt is not always the
/// text typed: attachments leave markers in it, a long one is clipped, whitespace is folded. An exact
/// comparison left such a send "unconfirmed" forever, and it was drawn after the agent's reply.
public enum SentTextMatch {
    private static let markers = try! NSRegularExpression(
        pattern: #"\[(?:image|attachment|attached|file|photo|pasted)[^\]]*\]|<(?:attachment|image|file)[^>]*>"#,
        options: [.caseInsensitive])

    public static func normalize(_ text: String) -> String {
        let range = NSRange(text.startIndex..., in: text)
        let stripped = markers.stringByReplacingMatches(in: text, range: range, withTemplate: " ")
        return stripped.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    public static func matches(sent: String, host: String) -> Bool {
        let a = normalize(sent), b = normalize(host)
        guard !a.isEmpty, !b.isEmpty else { return false }
        if a == b { return true }
        var (short, long) = a.count <= b.count ? (a, b) : (b, a)
        // A clipped copy ends in an ellipsis: compare what it kept.
        for tail in ["…", "..."] where short.hasSuffix(tail) { short = String(short.dropLast(tail.count)) }
        return short.count >= 12 && long.hasPrefix(short)
    }
}
