import CoreGraphics
import Foundation

/// The pure parts of how a message is laid out, kept apart from SwiftUI so they can be tested.
public enum MessageLayout {
    /// The space above `b` when it follows `a`, in points. `em` is the body size.
    /// Paragraph rhythm: a paragraph gap bigger than a line gap, room before and after a list and a heading,
    /// a list's items an even distance apart.
    public static func gap(from a: MessageMarkup.Block, to b: MessageMarkup.Block, em: CGFloat, style: MessageStyle) -> CGFloat {
        switch (a, b) {
        case (.listItem(_, let da, _), .listItem(_, let db, _)):
            if let fixed = style.listItemGap { return fixed * (em / max(style.bodySize, 1)) }
            return em * (da == db ? 0.3 : 0.22)
        case (.heading, .heading): return em * 0.5
        case (.heading, _): return em * style.headingGapBelow
        case (_, .heading): return em * style.headingGapAbove
        case (.listItem, _), (_, .listItem): return em * style.listGap
        case (_, .rule), (.rule, _): return em * 0.9
        case (.codeBlock, _), (_, .codeBlock), (.table, _), (_, .table), (.quote, _), (_, .quote): return em * 0.75
        default: return em * style.paragraphGap
        }
    }

    /// Break opportunities in a long path: a zero-width space after each `/` that has more path after it, so it
    /// wraps at a slash and nowhere else. Short text, and text with no slash, is returned as it is.
    public static func breakablePath(_ text: String, minimum: Int = 18) -> String {
        guard text.count >= minimum, text.contains("/") else { return text }
        var out = ""
        let chars = Array(text)
        for (i, c) in chars.enumerated() {
            out.append(c)
            if c == "/", i + 1 < chars.count, chars[i + 1] != "/", chars[i + 1] != " " { out.append("\u{200B}") }
        }
        return out
    }

    /// Undo `breakablePath`: copied text must carry no zero-width spaces.
    public static func strippingWrapHints(_ text: String) -> String {
        text.contains("\u{200B}") ? text.replacingOccurrences(of: "\u{200B}", with: "") : text
    }
}
