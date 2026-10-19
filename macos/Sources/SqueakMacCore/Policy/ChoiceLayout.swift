import Foundation

/// One answer card: a letter, a title, and the rest of the option's text as its description.
public struct ChoiceCard: Equatable, Sendable {
    public var letter: String
    public var title: String
    public var detail: String?
    public var isRecommended: Bool
}

/// An agent message split around its lettered options: prose before, the question as a heading,
/// one card per option, prose after. Built on `Choices.parseFull`, so it accepts exactly what the
/// chips accepted.
public struct ChoiceLayout: Equatable, Sendable {
    public var before: String
    public var question: String?
    public var cards: [ChoiceCard]
    public var after: String

    private static let optionLine = try! NSRegularExpression(
        pattern: #"^(?:[-*+]\s+)?(\*\*|__)?\(?([A-H])[).:](?:\*\*|__)?\s+(.+)$"#)

    public static func make(_ text: String) -> ChoiceLayout? {
        guard let parsed = Choices.parseFull(text), !parsed.options.isEmpty else { return nil }
        let lines = text.components(separatedBy: "\n")
        var inCode = false
        var hits: [(index: Int, rest: String)] = []
        var wanted = 0
        for (i, raw) in lines.enumerated() {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") { inCode.toggle(); continue }
            guard !inCode, wanted < parsed.options.count,
                  let m = optionLine.firstMatch(in: t, range: NSRange(t.startIndex..., in: t)),
                  let lr = Range(m.range(at: 2), in: t), String(t[lr]) == parsed.options[wanted].letter else { continue }
            // Everything after the letter marker, keeping any bold span for the title split.
            var rest = String(t[t.index(lr.upperBound, offsetBy: 1)...]).trimmingCharacters(in: .whitespaces)
            if let l = Range(m.range(at: 1), in: t) {
                if rest.hasPrefix("**") || rest.hasPrefix("__") {
                    rest = String(rest.dropFirst(2)).trimmingCharacters(in: .whitespaces)  // "**A)** text"
                } else {
                    rest = String(t[l]) + rest  // "**A) Title** — text": keep the bold for the title split
                }
            }
            hits.append((i, rest))
            wanted += 1
        }
        guard hits.count == parsed.options.count, let first = hits.first, let last = hits.last else { return nil }

        var beforeLines = Array(lines[..<first.index])
        // The question line becomes the heading, so it leaves the prose.
        if let q = parsed.question,
           let qi = beforeLines.lastIndex(where: { Choices.stripMarkdown($0).hasPrefix(String(q.prefix(20))) && $0.contains("?") }) {
            beforeLines.remove(at: qi)
        }
        let afterLines = Array(lines[(last.index + 1)...])

        let cards = zip(parsed.options, hits).map { opt, hit -> ChoiceCard in
            let (title, detail) = splitTitle(hit.rest)
            return ChoiceCard(letter: opt.letter, title: title.isEmpty ? opt.label : title, detail: detail, isRecommended: parsed.recommended == opt.letter || hit.rest.range(of: #"\((?:recommended|suggested)\)"#, options: [.regularExpression, .caseInsensitive]) != nil)
        }
        return ChoiceLayout(
            before: beforeLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines),
            question: parsed.question,
            cards: cards,
            after: afterLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Title is the text before the first " — ", ": " or sentence end (or the leading bold span); the rest is the description.
    static func splitTitle(_ raw: String) -> (String, String?) {
        var s = raw.replacingOccurrences(of: #"\s*\((?:recommended|suggested)\)\s*"#, with: " ", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: .whitespaces)
        var title: String?
        if let re = try? NSRegularExpression(pattern: #"^(?:\*\*|__)(.+?)(?:\*\*|__)"#),
           let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
           let r = Range(m.range(at: 1), in: s), let all = Range(m.range, in: s) {
            title = Choices.stripMarkdown(String(s[r]))
            s = String(s[all.upperBound...])
            s = String(s.drop(while: { " —–-:.".contains($0) || $0.isWhitespace })).trimmingCharacters(in: .whitespaces)
            return (title!.trimmingCharacters(in: CharacterSet(charactersIn: ".:")), s.isEmpty ? nil : Choices.stripMarkdown(s))
        }
        s = Choices.stripMarkdown(s)
        let chars = Array(s)
        var end = chars.count, skip = 0, i = 0
        while i < chars.count {
            if chars[i].isWhitespace, i + 2 < chars.count, "—–".contains(chars[i + 1]), chars[i + 2].isWhitespace { end = i; skip = 3; break }
            if chars[i] == ":", i + 1 < chars.count, chars[i + 1].isWhitespace { end = i; skip = 2; break }
            if chars[i] == ".", i + 1 < chars.count, chars[i + 1].isWhitespace { end = i; skip = 2; break }
            i += 1
        }
        let t = String(chars[..<end]).trimmingCharacters(in: .whitespaces)
        let rest = end + skip < chars.count ? String(chars[(end + skip)...]).trimmingCharacters(in: .whitespaces) : ""
        return (t, rest.isEmpty ? nil : rest)
    }
}
