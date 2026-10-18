import Foundation

/// A small, safe Markdown subset for agent and user messages.
///
/// Agent text is untrusted. This parser only produces a plain value tree: it never
/// interprets HTML, never builds URLs, and never fetches anything. Unclosed markers
/// stay literal. The renderer decides how to show links (as text, never clickable).
public enum MessageMarkup {
    public indirect enum Inline: Equatable, Sendable {
        case text(String)
        case bold([Inline])
        case italic([Inline])
        case code(String)
        /// `[label](destination)`. The destination is a string to display, nothing more.
        case link(label: [Inline], destination: String)
    }

    public enum ListMarker: Equatable, Sendable {
        case bullet
        case number(Int)
    }

    public enum Block: Equatable, Sendable {
        case paragraph([Inline])
        case heading(level: Int, [Inline])
        case listItem(marker: ListMarker, depth: Int, [Inline])
        case codeBlock(language: String?, code: String)
        case quote([Inline])
    }

    public static func parse(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var para: [String] = []
        var quote: [String] = []
        var item: (marker: ListMarker, depth: Int, lines: [String])?

        func flushPara() {
            if !para.isEmpty { blocks.append(.paragraph(parseInlines(para.joined(separator: "\n")))) }
            para = []
        }
        func flushQuote() {
            if !quote.isEmpty { blocks.append(.quote(parseInlines(quote.joined(separator: "\n")))) }
            quote = []
        }
        func flushItem() {
            if let i = item { blocks.append(.listItem(marker: i.marker, depth: i.depth, parseInlines(i.lines.joined(separator: "\n")))) }
            item = nil
        }
        func flushAll() { flushPara(); flushQuote(); flushItem() }

        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
            line.hasSuffix("\r") ? line.dropLast() : line
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            let indent = line.distance(from: line.startIndex, to: trimmed.startIndex)

            if trimmed.hasPrefix("```") {
                flushAll()
                let info = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
                let language = info.split(separator: " ").first.map(String.init)
                var body: [Substring] = []
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix("```"), t.dropFirst(3).allSatisfy({ $0 == "`" }) { break }
                    body.append(lines[i])
                    i += 1
                }
                blocks.append(.codeBlock(language: language, code: body.joined(separator: "\n")))
                i += 1 // closing fence (or past the end when unclosed)
                continue
            }
            if trimmed.isEmpty { flushAll(); i += 1; continue }

            if let (level, content) = heading(trimmed) {
                flushAll()
                blocks.append(.heading(level: level, parseInlines(content)))
            } else if let (marker, content) = listMarker(trimmed) {
                flushAll()
                item = (marker, min(indent / 2, 4), [content])
            } else if trimmed.hasPrefix(">") {
                flushPara(); flushItem()
                var rest = trimmed.dropFirst()
                if rest.hasPrefix(" ") { rest = rest.dropFirst() }
                quote.append(String(rest))
            } else if item != nil, indent >= 2, quote.isEmpty {
                item?.lines.append(String(trimmed))
            } else {
                flushQuote(); flushItem()
                para.append(String(line))
            }
            i += 1
        }
        flushAll()
        return blocks
    }

    // MARK: Block helpers

    private static func heading(_ s: Substring) -> (Int, String)? {
        var level = 0
        for c in s { if c == "#" { level += 1 } else { break } }
        guard (1...6).contains(level) else { return nil }
        let rest = s.dropFirst(level)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var content = rest.trimmingCharacters(in: .whitespaces)
        while content.hasSuffix("#") { content.removeLast() }
        return (level, content.trimmingCharacters(in: .whitespaces))
    }

    private static func listMarker(_ s: Substring) -> (ListMarker, String)? {
        if let f = s.first, "-*+".contains(f), s.dropFirst().first == " " {
            return (.bullet, String(s.dropFirst(2)))
        }
        let digits = s.prefix(while: { $0.isASCII && $0.isNumber })
        guard (1...9).contains(digits.count) else { return nil }
        let rest = s.dropFirst(digits.count)
        guard let d = rest.first, d == "." || d == ")", rest.dropFirst().first == " ", let n = Int(digits) else { return nil }
        return (.number(n), String(rest.dropFirst(2)))
    }

    // MARK: Inline

    public static func parseInlines(_ text: String) -> [Inline] {
        let scalars = Array(text.unicodeScalars)
        var parser = InlineParser(s: scalars)
        return parser.parse(0, scalars.count, depth: 0)
    }

    private struct InlineParser {
        let s: [Unicode.Scalar]
        /// Per marker: a search that started at or before this index and found nothing,
        /// so no later search can succeed either. Keeps unclosed markers linear.
        var failedFrom: [String: (from: Int, hi: Int)] = [:]

        static let maxDepth = 4
        static let maxURL = 2048

        init(s: [Unicode.Scalar]) { self.s = s }

        func isSpace(_ c: Unicode.Scalar) -> Bool { c == " " || c == "\t" || c == "\n" }
        func isWord(_ c: Unicode.Scalar) -> Bool { c.properties.isAlphabetic || (c.value >= 48 && c.value <= 57) }

        mutating func parse(_ lo: Int, _ hi: Int, depth: Int) -> [Inline] {
            var out: [Inline] = []
            var plain = String.UnicodeScalarView()
            func flush() {
                if !plain.isEmpty { out.append(.text(String(plain))); plain = .init() }
            }
            var i = lo
            while i < hi {
                let c = s[i]
                if c == "\\", i + 1 < hi, s[i + 1].isASCII, s[i + 1].properties.generalCategory.isPunctuationOrSymbol {
                    plain.append(s[i + 1]); i += 2; continue
                }
                if depth <= Self.maxDepth {
                    if c == "`", let (content, next) = codeSpan(i, hi) {
                        flush(); out.append(.code(content)); i = next; continue
                    }
                    if c == "*" || c == "_", i + 1 < hi, s[i + 1] == c,
                       let close = closer(c, 2, from: i + 2, hi, openAt: i) {
                        flush(); out.append(.bold(parse(i + 2, close, depth: depth + 1))); i = close + 2; continue
                    }
                    if c == "*" || c == "_", let close = closer(c, 1, from: i + 1, hi, openAt: i) {
                        flush(); out.append(.italic(parse(i + 1, close, depth: depth + 1))); i = close + 1; continue
                    }
                    if c == "[", let (labelEnd, dest, next) = link(i, hi) {
                        flush()
                        out.append(.link(label: parse(i + 1, labelEnd, depth: depth + 1), destination: dest))
                        i = next; continue
                    }
                }
                plain.append(c); i += 1
            }
            flush()
            return out
        }

        /// A backtick span closed by a backtick run of the same length.
        mutating func codeSpan(_ at: Int, _ hi: Int) -> (String, Int)? {
            var n = 0
            while at + n < hi, s[at + n] == "`" { n += 1 }
            let key = "`\(n)"
            if let f = failedFrom[key], at >= f.from, hi <= f.hi { return nil }
            var j = at + n
            while j < hi {
                if s[j] == "`" {
                    var m = 0
                    while j + m < hi, s[j + m] == "`" { m += 1 }
                    if m == n {
                        var view = String.UnicodeScalarView()
                        view.append(contentsOf: s[(at + n)..<j])
                        guard !view.isEmpty else { return nil }
                        return (String(view), j + n)
                    }
                    j += m
                } else { j += 1 }
            }
            failedFrom[key] = (at, hi)
            return nil
        }

        /// Index of the closing delimiter run for an opener at `openAt`, or nil.
        mutating func closer(_ c: Unicode.Scalar, _ n: Int, from: Int, _ hi: Int, openAt: Int) -> Int? {
            guard from < hi, !isSpace(s[from]), n == 2 || s[from] != c else { return nil }
            // `_` inside a word (snake_case) is not emphasis.
            if c == "_", openAt > 0, isWord(s[openAt - 1]) { return nil }
            // A longer run of the same marker (`***`) is left to the shorter parse.
            let key = "\(c)\(n)"
            if let f = failedFrom[key], openAt >= f.from, hi <= f.hi { return nil }
            var j = from
            while j < hi {
                let d = s[j]
                if d == "\\" { j += 2; continue }
                if d == "`" { // skip over code spans
                    if let (_, next) = codeSpan(j, hi) { j = next; continue }
                }
                if d == c {
                    var run = 0
                    while j + run < hi, s[j + run] == c { run += 1 }
                    if (n == 2 ? run >= 2 : run == 1), !isSpace(s[j - 1]) {
                        if c == "_", j + n < hi, isWord(s[j + n]) { j += run; continue }
                        // Use the last n of the run so `**a***` still closes.
                        return j + (run - n)
                    }
                    j += run
                } else { j += 1 }
            }
            failedFrom[key] = (openAt, hi)
            return nil
        }

        /// `[label](destination)` with a space-free destination.
        func link(_ at: Int, _ hi: Int) -> (Int, String, Int)? {
            var depth = 0
            var j = at
            while j < hi {
                if s[j] == "\\" { j += 2; continue }
                if s[j] == "[" { depth += 1 }
                if s[j] == "]" { depth -= 1; if depth == 0 { break } }
                if j - at > 400 { return nil }
                j += 1
            }
            guard j < hi, depth == 0, j + 1 < hi, s[j + 1] == "(", j > at + 1 else { return nil }
            var k = j + 2
            var dest = String.UnicodeScalarView()
            var count = 0
            while k < hi, s[k] != ")" {
                count += 1
                if isSpace(s[k]) || s[k].properties.generalCategory == .control || count > Self.maxURL { return nil }
                dest.append(s[k]); k += 1
            }
            guard k < hi, !dest.isEmpty else { return nil }
            return (j, String(dest), k + 1)
        }
    }
}

private extension Unicode.GeneralCategory {
    var isPunctuationOrSymbol: Bool {
        switch self {
        case .connectorPunctuation, .dashPunctuation, .openPunctuation, .closePunctuation,
             .initialPunctuation, .finalPunctuation, .otherPunctuation,
             .mathSymbol, .currencySymbol, .modifierSymbol, .otherSymbol: true
        default: false
        }
    }
}
