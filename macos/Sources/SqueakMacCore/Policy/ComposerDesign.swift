import Foundation

/// Pure parts of the unified composer card (DESIGN.md §8.12, Direction A): when the status line shows, how duckling chips
/// are cut and fitted, how far the text area grows before it scrolls, and the hint beside Send while the agent works.
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

    /// The field's height from the height its text wants (`content`, inset included): whole lines of `lineHeight`,
    /// at least `minLines`, at most `maxLines`, then it scrolls inside.
    public static func fieldHeight(content: Double, lineHeight: Double = 22, minLines: Int = 1, maxLines: Int = 8, inset: Double = 12) -> Growth {
        let lines = max(1, Int(((content - inset) / lineHeight).rounded()))
        return growth(lines: lines, lineHeight: lineHeight, minLines: minLines, maxLines: maxLines, inset: inset)
    }

    /// The status line is drawn only while there is something to say about background work (the ducklings bar's text);
    /// an idle chat with nothing running is just the text and the toolbar.
    public static func showsStatus(barText: String?) -> Bool { barText != nil }

    /// The status line's lead: the chat's ready line ("Ready · 2 ducklings running") when it has one, else the bar's text.
    public static func statusLead(barText: String, readyLine: String?) -> String { readyLine ?? barText }

    /// How many chips to try, most first: every chip, then one fewer with "+N", down to none and "+N". The view takes
    /// the first that fits whole, so a chip is never cut by the edge.
    public static func fitOptions(count: Int) -> [Int] { count <= 0 ? [0] : Array(stride(from: count, through: 0, by: -1)) }

    /// "+2" for the chips left out; nil when all are shown.
    public static func overflowLabel(total: Int, shown: Int) -> String? { total > shown ? "+\(total - shown)" : nil }

    /// Beside Send while the agent works and words are typed: what the button does now and what ⌘↩ does instead.
    public static func sendHint(working: Bool, hasText: Bool, primary: SendMode) -> String? {
        guard working, hasText else { return nil }
        return primary == .steer ? "Steers now \u{00B7} \u{2318}\u{21A9} to queue" : "Queues \u{00B7} \u{2318}\u{21A9} to steer now"
    }
}
