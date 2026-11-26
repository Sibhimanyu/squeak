import Foundation

/// Pure parts of the composer redesign (mocked in `ComposerMocks.swift`, not yet the live composer): how a duckling chip's
/// title is shortened and how far the text area grows before it scrolls.
public enum ComposerDesign {
    /// A chip title cut at a word boundary, never mid-word: "YouTube: shared Google sign-in + Studio fallback" at 28
    /// characters is "YouTube: shared Google…". A single word longer than the limit is kept whole (the chip may then be
    /// dropped into "+N" by the layout rather than cut). Trailing punctuation before the cut is dropped.
    public static func chipTitle(_ title: String, maxCharacters: Int) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count > maxCharacters else { return t }
        var out = ""
        for word in t.split(separator: " ", omittingEmptySubsequences: true) {
            let next = out.isEmpty ? String(word) : out + " " + word
            if next.count > maxCharacters { break }
            out = next
        }
        if out.isEmpty { return String(t.split(separator: " ").first ?? Substring(t)) }
        while let last = out.last, ":;,.-+·&/".contains(last) || last == " " { out.removeLast() }
        return out + "\u{2026}"
    }

    /// The text area's growth: one line of `lineHeight` per line of text from `minLines` up to `maxLines`, then it stops
    /// growing and scrolls inside. The toolbar under it never moves relative to the box's bottom edge.
    public struct Growth: Equatable, Sendable {
        public let height: Double
        public let scrolls: Bool
        public init(height: Double, scrolls: Bool) { self.height = height; self.scrolls = scrolls }
    }

    public static func growth(lines: Int, lineHeight: Double = 22, minLines: Int = 1, maxLines: Int = 8, inset: Double = 12) -> Growth {
        let shown = min(max(lines, minLines), maxLines)
        return Growth(height: Double(shown) * lineHeight + inset, scrolls: lines > maxLines)
    }
}
