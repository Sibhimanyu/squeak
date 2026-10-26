import Foundation

/// Plain-text bullets from a Sparkle item's HTML description (what `scripts/appcast-notes.py` writes).
/// Only the version's own list is read: the newest item also carries "Also in x.y.z" sections under
/// headings, and those are cut off. Empty when the description has no list items.
public enum ReleaseNotes {
    public static func bullets(fromHTML html: String?) -> [String] {
        guard var text = html, !text.isEmpty else { return [] }
        text = text.replacingOccurrences(of: #"(?is)<(style|script|head)\b.*?</\1>"#, with: "", options: .regularExpression)
        if let h = text.range(of: #"(?i)<h[1-6][\s>]"#, options: .regularExpression) { text = String(text[..<h.lowerBound]) }
        let ns = text as NSString
        guard let li = try? NSRegularExpression(pattern: #"<li\b[^>]*>(.*?)</li>"#, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
        return li.matches(in: text, range: NSRange(location: 0, length: ns.length)).compactMap { m in
            let line = clean(ns.substring(with: m.range(at: 1)))
            return line.isEmpty ? nil : line
        }
    }

    private static func clean(_ fragment: String) -> String {
        var t = fragment.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        for (entity, ch) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&nbsp;", " "), ("&amp;", "&")] {
            t = t.replacingOccurrences(of: entity, with: ch)
        }
        return t.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
