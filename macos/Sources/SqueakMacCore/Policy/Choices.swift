import Foundation

/// One lettered option an agent offered ("A) Retry once").
public struct Choice: Equatable, Hashable, Sendable {
    public var letter: String
    public var label: String
    public init(letter: String, label: String) { self.letter = letter; self.label = label }
}

public struct ParsedChoices: Equatable, Sendable {
    public var question: String?
    public var options: [Choice]
    public var recommended: String?
}

/// Port of src/fleet/choices.ts: reads "pick one of these" out of an agent's last
/// message. Letters only (numbered lists are summaries), at least two options
/// running A, B, C... and never two lettered blocks (a bare letter would be ambiguous).
public enum Choices {
    static let optionTitleMax = 70
    static let questionMax = 120

    // ^(?:[-*+]\s+)?(?:\*\*|__)?\(?([A-H])[).:](?:\*\*|__)?\s+(.+)$
    private static let optionLine = try! NSRegularExpression(
        pattern: #"^(?:[-*+]\s+)?(?:\*\*|__)?\(?([A-H])[).:](?:\*\*|__)?\s+(.+)$"#)

    public static func parse(_ text: String) -> [Choice] { parseFull(text)?.options ?? [] }

    public static func parseFull(_ text: String?) -> ParsedChoices? {
        guard let text, !text.isEmpty else { return nil }
        let withoutCode = text.replacingOccurrences(of: #"```[\s\S]*?```"#, with: "", options: .regularExpression)
        let lines = withoutCode.components(separatedBy: "\n")

        var found: [(letter: String, line: String, index: Int)] = []
        for (i, raw) in lines.enumerated() {
            let t = raw.trimmingCharacters(in: .whitespaces)
            let r = NSRange(t.startIndex..., in: t)
            if let m = optionLine.firstMatch(in: t, range: r), let lr = Range(m.range(at: 1), in: t) {
                found.append((String(t[lr]), t, i))
            }
        }
        var options: [(letter: String, line: String, index: Int)] = []
        for c in found {
            let expected = String(UnicodeScalar(UInt8(65 + options.count)))
            if c.letter == expected { options.append(c) } else if c.letter == "A" { return nil }
        }
        guard options.count >= 2 else { return nil }

        let parsed = options.map { Choice(letter: $0.letter, label: optionTitle($0.line)) }
        let recommended = findRecommendation(withoutCode: text, parsed)
        let cleaned = parsed.map {
            Choice(letter: $0.letter, label: $0.label.replacingOccurrences(
                of: #"\s*\((?:recommended|suggested)\)\s*"#, with: " ", options: [.regularExpression, .caseInsensitive]
            ).trimmingCharacters(in: .whitespaces))
        }
        return ParsedChoices(question: findQuestion(Array(lines[..<options[0].index])), options: cleaned, recommended: recommended)
    }

    /// Port of card-text.ts `stripMarkdown`.
    public static func stripMarkdown(_ text: String) -> String {
        var s = text
        func sub(_ pattern: String, _ with: String, _ opts: NSRegularExpression.Options = []) {
            guard let re = try? NSRegularExpression(pattern: pattern, options: opts) else { return }
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: with)
        }
        sub(#"```[\s\S]*?```"#, " ")
        sub(#"`([^`]*)`"#, "$1")
        sub(#"!?\[([^\]]*)\]\([^)]*\)"#, "$1")
        sub(#"^\s{0,3}#{1,6}\s+"#, "", .anchorsMatchLines)
        sub(#"^\s{0,3}>\s?"#, "", .anchorsMatchLines)
        sub(#"^\s{0,3}(?:[-*+]|\d+[.)])\s+"#, "· ", .anchorsMatchLines)
        sub(#"\*\*([^*]+)\*\*"#, "$1")
        sub(#"(?<![*\w])\*([^*\n]+)\*(?!\*)"#, "$1")
        sub(#"(?<![_\w])_([^_\n]+)_(?!\w)"#, "$1")
        sub(#"^\s{0,3}(?:[-*_]\s*){3,}$"#, " ", .anchorsMatchLines)
        sub(#"\s+"#, " ")
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func clip(_ s: String, _ max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)).trimmingCharacters(in: .whitespaces) + "…"
    }

    private static func optionTitle(_ line: String) -> String {
        let withoutMarker = line.replacingOccurrences(of: #"^[-*+]\s+"#, with: "", options: .regularExpression)
        var bold: String?
        if let re = try? NSRegularExpression(pattern: #"^(?:\*\*|__)(.+?)(?:\*\*|__)"#),
           let m = re.firstMatch(in: withoutMarker, range: NSRange(withoutMarker.startIndex..., in: withoutMarker)),
           let r = Range(m.range(at: 1), in: withoutMarker) {
            bold = String(withoutMarker[r])
        }
        var title = stripMarkdown(bold ?? withoutMarker)
            .replacingOccurrences(of: #"^\(?[A-H][).:]\s*"#, with: "", options: .regularExpression)
        if bold == nil {
            // First sentence, or text before a dash.
            let chars = Array(title)
            var end = chars.count
            var i = 0
            while i < chars.count {
                if ".!?".contains(chars[i]), i + 1 < chars.count, chars[i + 1].isWhitespace { end = i + 1; break }
                if chars[i].isWhitespace, i + 2 < chars.count, "—–".contains(chars[i + 1]), chars[i + 2].isWhitespace { end = i; break }
                i += 1
            }
            title = String(chars[..<end])
        }
        title = title.replacingOccurrences(of: #"[.:]\s*$"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
        return clip(title, optionTitleMax)
    }

    private static func findQuestion(_ before: [String]) -> String? {
        for line in before.reversed() {
            let flat = stripMarkdown(line)
                .replacingOccurrences(of: #"\((?:reply|answer|respond) with [^)]*\)"#, with: "", options: [.regularExpression, .caseInsensitive])
                .trimmingCharacters(in: .whitespaces)
            if flat.contains("?") { return clip(flat, questionMax) }
        }
        return nil
    }

    private static func findRecommendation(withoutCode text: String, _ options: [Choice]) -> String? {
        let letters = Set(options.map(\.letter))
        if let re = try? NSRegularExpression(
            pattern: #"recommend(?:ation|ed)?\s*[:：]\s*(?:\*\*)?(?:option\s+)?\(?([A-H])\b"#, options: .caseInsensitive),
           let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
           let r = Range(m.range(at: 1), in: text) {
            let l = String(text[r]).uppercased()
            if letters.contains(l) { return l }
        }
        return options.first { $0.label.range(of: #"\brecommended\b"#, options: [.regularExpression, .caseInsensitive]) != nil }?.letter
    }
}
