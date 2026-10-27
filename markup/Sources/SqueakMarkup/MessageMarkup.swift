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
        case strike([Inline])
        case code(String)
        /// `[label](destination)`. The destination is a string to display, nothing more.
        case link(label: [Inline], destination: String)
        /// A bare `https://…` address in the text, shown as an address, never opened.
        case url(String)
        /// A file path in the text (`src/a.ts:12`, `~/x`, `/etc/hosts`), shown as code.
        case path(String)
    }

    public enum ListMarker: Equatable, Sendable {
        case bullet
        case number(Int)
        /// `- [ ]` / `- [x]`
        case task(done: Bool)
    }

    public enum Alignment: Equatable, Sendable { case leading, center, trailing }

    public enum Block: Equatable, Sendable {
        case paragraph([Inline])
        case heading(level: Int, [Inline])
        /// One list item. Nesting is the item's `depth` (0...4).
        case listItem(marker: ListMarker, depth: Int, [Inline])
        case codeBlock(language: String?, code: String)
        case quote([Block])
        case rule
        case table(header: [[Inline]], alignments: [Alignment], rows: [[[Inline]]])
        /// `![alt](source)` alone in its paragraph: an image the agent made. `source` is a string
        /// to show and to ask the host for, nothing more; the parser never opens it.
        case image(alt: String, source: String)
    }

    /// `![alt](source)` and nothing else, the way agents put a screenshot in an answer; `<…>`
    /// around the source is the angle form some write.
    static func standaloneImage(_ text: String) -> Block? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("!["), t.hasSuffix(")"), !t.contains("\n"),
              let close = t.range(of: "]("), t.distance(from: t.startIndex, to: close.lowerBound) > 1 else { return nil }
        let alt = String(t[t.index(t.startIndex, offsetBy: 2)..<close.lowerBound])
        var source = String(t[close.upperBound..<t.index(before: t.endIndex)])
        if source.hasPrefix("<"), source.hasSuffix(">") { source = String(source.dropFirst().dropLast()) }
        guard !source.isEmpty, source.count <= 2_000, !alt.contains("]"), !source.contains("\n") else { return nil }
        return .image(alt: alt, source: source)
    }

    public static func parse(_ text: String) -> [Block] {
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> Substring in
            line.hasSuffix("\r") ? line.dropLast() : line
        }
        return parseBlocks(lines, depth: 0)
    }

    static let maxQuoteDepth = 3

    private static func parseBlocks(_ lines: [Substring], depth quoteDepth: Int) -> [Block] {
        var blocks: [Block] = []
        var para: [String] = []
        var quote: [String] = []
        var item: (marker: ListMarker, depth: Int, lines: [String])?

        func flushPara() {
            if !para.isEmpty {
                let text = para.joined(separator: "\n")
                blocks.append(standaloneImage(text) ?? .paragraph(parseInlines(text)))
            }
            para = []
        }
        func flushQuote() {
            if !quote.isEmpty {
                let inner = quote.map { Substring($0) }
                if quoteDepth < maxQuoteDepth {
                    blocks.append(.quote(parseBlocks(inner, depth: quoteDepth + 1)))
                } else {
                    blocks.append(.quote([.paragraph(parseInlines(quote.joined(separator: "\n")))]))
                }
            }
            quote = []
        }
        func flushItem() {
            if let i = item {
                blocks.append(.listItem(marker: i.marker, depth: i.depth, parseInlines(i.lines.joined(separator: "\n"))))
            }
            item = nil
        }
        func flushAll() { flushPara(); flushQuote(); flushItem() }

        func indentOf(_ line: Substring) -> Int {
            var n = 0
            for c in line {
                if c == " " { n += 1 } else if c == "\t" { n += 4 } else { break }
            }
            return n
        }

        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
            let indent = indentOf(line)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushAll()
                let fence = trimmed.first!
                let info = trimmed.drop(while: { $0 == fence }).trimmingCharacters(in: .whitespaces)
                let language = info.split(separator: " ").first.map(String.init)
                var body: [Substring] = []
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix(String(repeating: fence, count: 3)), t.allSatisfy({ $0 == fence }) { break }
                    // Remove the fence's own indentation (a fence inside a list item).
                    var l = lines[i]
                    var strip = min(indent, indentOf(l))
                    while strip > 0, l.first == " " { l = l.dropFirst(); strip -= 1 }
                    body.append(l)
                    i += 1
                }
                blocks.append(.codeBlock(language: language, code: body.joined(separator: "\n")))
                i += 1 // closing fence (or past the end when unclosed)
                continue
            }
            if trimmed.isEmpty {
                // A list item continues over a blank line when the next text is indented under it.
                if item != nil, !(item!.lines.last?.isEmpty ?? true) {
                    var j = i + 1
                    while j < lines.count, lines[j].allSatisfy({ $0 == " " || $0 == "\t" }) { j += 1 }
                    if j < lines.count {
                        let next = lines[j]
                        let nt = next.drop(while: { $0 == " " || $0 == "\t" })
                        if indentOf(next) >= 2, listMarker(nt) == nil, !nt.hasPrefix("```"), !nt.hasPrefix("~~~") {
                            item?.lines.append("")
                            i += 1
                            continue
                        }
                    }
                }
                flushAll(); i += 1; continue
            }

            if indent >= 4, para.isEmpty, quote.isEmpty, item == nil {
                // Indented code: runs of indented lines, blank lines kept when more follow.
                flushAll()
                var body: [String] = []
                while i < lines.count {
                    let l = lines[i]
                    if l.allSatisfy({ $0 == " " || $0 == "\t" }) {
                        var j = i
                        while j < lines.count, lines[j].allSatisfy({ $0 == " " || $0 == "\t" }) { j += 1 }
                        if j < lines.count, indentOf(lines[j]) >= 4 {
                            body.append(contentsOf: Array(repeating: "", count: j - i)); i = j; continue
                        }
                        break
                    }
                    guard indentOf(l) >= 4 else { break }
                    var s = l
                    if s.first == "\t" { s = s.dropFirst() } else { s = s.dropFirst(4) }
                    body.append(String(s))
                    i += 1
                }
                blocks.append(.codeBlock(language: nil, code: body.joined(separator: "\n")))
                continue
            }

            if isRule(trimmed) {
                flushAll()
                blocks.append(.rule)
            } else if let (level, content) = heading(trimmed) {
                flushAll()
                blocks.append(.heading(level: level, parseInlines(content)))
            } else if quote.isEmpty, let table = table(lines, at: i, firstLine: trimmed) {
                flushAll()
                blocks.append(table.block)
                i = table.next
                continue
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
            } else if item == nil, quote.isEmpty, let image = standaloneImage(String(trimmed)) {
                // An image alone on its line is a block even straight after a label line.
                flushPara()
                blocks.append(image)
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

    private static func isRule(_ s: Substring) -> Bool {
        guard let f = s.first, "-*_".contains(f) else { return false }
        var n = 0
        for c in s {
            if c == f { n += 1 } else if c != " " { return false }
        }
        return n >= 3
    }

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
            let rest = s.dropFirst(2)
            if rest.hasPrefix("[ ] ") { return (.task(done: false), String(rest.dropFirst(4))) }
            if rest.hasPrefix("[x] ") || rest.hasPrefix("[X] ") { return (.task(done: true), String(rest.dropFirst(4))) }
            return (.bullet, String(rest))
        }
        let digits = s.prefix(while: { $0.isASCII && $0.isNumber })
        guard (1...9).contains(digits.count) else { return nil }
        let rest = s.dropFirst(digits.count)
        guard let d = rest.first, d == "." || d == ")", rest.dropFirst().first == " ", let n = Int(digits) else { return nil }
        return (.number(n), String(rest.dropFirst(2)))
    }

    // MARK: Tables

    /// Splits a table row on `|`. A pipe inside backticks or after a backslash is content.
    static func splitRow(_ line: Substring) -> [String] {
        var cells: [String] = []
        var cur = String.UnicodeScalarView()
        var inCode = false
        var scalars = Array(line.trimmingCharacters(in: .whitespaces).unicodeScalars)
        if scalars.first == "|" { scalars.removeFirst() }
        var endsWithPipe = false
        if scalars.last == "|", scalars.count < 2 || scalars[scalars.count - 2] != "\\" {
            scalars.removeLast(); endsWithPipe = true
        }
        _ = endsWithPipe
        var k = 0
        while k < scalars.count {
            let c = scalars[k]
            if c == "\\", k + 1 < scalars.count, scalars[k + 1] == "|" {
                cur.append("|"); k += 2; continue
            }
            if c == "`" { inCode.toggle() }
            if c == "|", !inCode {
                cells.append(String(cur).trimmingCharacters(in: .whitespaces)); cur = .init()
            } else { cur.append(c) }
            k += 1
        }
        cells.append(String(cur).trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func delimiterAlignments(_ line: Substring) -> [Alignment]? {
        guard line.contains("-") else { return nil }
        let cells = splitRow(line)
        var out: [Alignment] = []
        for c in cells {
            var s = Substring(c)
            let left = s.hasPrefix(":")
            if left { s = s.dropFirst() }
            let right = s.hasSuffix(":")
            if right { s = s.dropLast() }
            guard !s.isEmpty, s.allSatisfy({ $0 == "-" }) else { return nil }
            out.append(left && right ? .center : right ? .trailing : .leading)
        }
        return out.isEmpty ? nil : out
    }

    private static func table(_ lines: [Substring], at i: Int, firstLine: Substring) -> (block: Block, next: Int)? {
        guard firstLine.contains("|"), i + 1 < lines.count else { return nil }
        let delimiter = lines[i + 1].trimmingCharacters(in: .whitespaces)
        guard delimiter.contains("|") || delimiter.hasPrefix(":") || delimiter.hasPrefix("-"),
              let aligns = delimiterAlignments(Substring(delimiter)) else { return nil }
        let header = splitRow(firstLine)
        guard header.count == aligns.count else { return nil }
        // A lone `---` under a line with one pipe is a rule, not a table.
        guard header.count >= 2 || firstLine.hasPrefix("|") else { return nil }
        var rows: [[[Inline]]] = []
        var j = i + 2
        while j < lines.count, rows.count < 500 {
            let t = lines[j].trimmingCharacters(in: .whitespaces)
            guard !t.isEmpty, t.contains("|") else { break }
            var cells = splitRow(Substring(t))
            if cells.count > aligns.count { cells = Array(cells.prefix(aligns.count)) }
            while cells.count < aligns.count { cells.append("") }
            rows.append(cells.map { parseInlines($0) })
            j += 1
        }
        return (.table(header: header.map { parseInlines($0) }, alignments: aligns, rows: rows), j)
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
        func isAlnum(_ c: Unicode.Scalar) -> Bool { c.isASCII && (c.properties.isAlphabetic || (c.value >= 48 && c.value <= 57)) }

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
                    if c == "~", i + 1 < hi, s[i + 1] == "~",
                       let close = closer(c, 2, from: i + 2, hi, openAt: i) {
                        flush(); out.append(.strike(parse(i + 2, close, depth: depth + 1))); i = close + 2; continue
                    }
                    if c == "*" || c == "_", let close = closer(c, 1, from: i + 1, hi, openAt: i) {
                        flush(); out.append(.italic(parse(i + 1, close, depth: depth + 1))); i = close + 1; continue
                    }
                    if c == "!", i + 1 < hi, s[i + 1] == "[", let (labelEnd, _, next) = link(i + 1, hi) {
                        // An image is shown as its description; nothing is fetched.
                        var alt = String.UnicodeScalarView()
                        alt.append(contentsOf: s[(i + 2)..<labelEnd])
                        plain.append(contentsOf: "[image: \(String(alt))]".unicodeScalars)
                        i = next; continue
                    }
                    if c == "[", let (labelEnd, dest, next) = link(i, hi) {
                        flush()
                        out.append(.link(label: parse(i + 1, labelEnd, depth: depth + 1), destination: dest))
                        i = next; continue
                    }
                    if i == lo || boundary(s[i - 1]) {
                        if (c == "h" || c == "H"), let (u, next) = bareURL(i, hi) {
                            flush(); out.append(.url(u)); i = next; continue
                        }
                        if c == "." || c == "~" || c == "/" || isAlnum(c) || c == "_" || c == "-",
                           let (p, next) = filePath(i, hi) {
                            flush(); out.append(.path(p)); i = next; continue
                        }
                    }
                }
                plain.append(c); i += 1
            }
            flush()
            return out
        }

        func boundary(_ c: Unicode.Scalar) -> Bool {
            isSpace(c) || c == "(" || c == "[" || c == "\"" || c == "'" || c == "“" || c == ">" || c == "—" || c == ","
        }

        /// `http://` or `https://` up to the end of the address, without trailing punctuation.
        func bareURL(_ at: Int, _ hi: Int) -> (String, Int)? {
            let scheme = at + 7 <= hi && String(String.UnicodeScalarView(s[at..<(at + 7)])).lowercased() == "http://" ? 7
                : at + 8 <= hi && String(String.UnicodeScalarView(s[at..<(at + 8)])).lowercased() == "https://" ? 8 : 0
            guard scheme > 0 else { return nil }
            var j = at + scheme
            while j < hi, !isSpace(s[j]), s[j] != "<", s[j] != ">", s[j] != "\"", s[j] != "`", s[j].properties.generalCategory != .control,
                  j - at <= Self.maxURL { j += 1 }
            var end = j
            while end > at + scheme {
                let t = s[end - 1]
                if ".,;:!?'*_~".unicodeScalars.contains(t) { end -= 1; continue }
                if t == ")" || t == "]" {
                    let open: Unicode.Scalar = t == ")" ? "(" : "["
                    let opens = s[at..<end].filter { $0 == open }.count
                    let closes = s[at..<end].filter { $0 == t }.count
                    if closes > opens { end -= 1; continue }
                }
                break
            }
            guard end > at + scheme else { return nil }
            var v = String.UnicodeScalarView()
            v.append(contentsOf: s[at..<end])
            return (String(v), end)
        }

        /// A path shown as code: `./a`, `../a`, `~/a`, `/a/b`, or `dir/file.ext` — optionally `:line[:col]`.
        func filePath(_ at: Int, _ hi: Int) -> (String, Int)? {
            let stops = " \t\n()[]<>\"'`,;*|{}\\".unicodeScalars
            var j = at
            var slash = false
            while j < hi, !stops.contains(s[j]), j - at < 400 {
                if s[j] == "/" { slash = true }
                j += 1
            }
            guard slash else { return nil }
            var end = j
            while end > at, ".:!?".unicodeScalars.contains(s[end - 1]) { end -= 1 }
            guard end - at >= 3 else { return nil }
            var tok = String.UnicodeScalarView()
            tok.append(contentsOf: s[at..<end])
            let t = String(tok)
            if t.contains("://") || t.contains("//") || t.hasSuffix("/") && !t.hasPrefix("/") && !t.hasPrefix("~/") && !t.hasPrefix(".") { return nil }
            // Drop a `:12` or `:12:3` suffix for validation only.
            var core = Substring(t)
            for _ in 0..<2 {
                if let colon = core.lastIndex(of: ":"), core[core.index(after: colon)...].allSatisfy({ $0.isASCII && $0.isNumber }),
                   !core[core.index(after: colon)...].isEmpty {
                    core = core[..<colon]
                }
            }
            guard !core.contains(":") else { return nil }
            let prefixed = core.hasPrefix("./") || core.hasPrefix("../") || core.hasPrefix("~/")
            let absolute = core.hasPrefix("/")
            let segments = core.split(separator: "/", omittingEmptySubsequences: false)
            guard segments.count >= 2 else { return nil }
            let allowed: (Character) -> Bool = { $0.isLetter || $0.isNumber || "._-@+~=#%".contains($0) }
            for seg in segments where !seg.allSatisfy(allowed) { return nil }
            let last = segments.last!
            let hasExt: Bool = {
                guard let dot = last.lastIndex(of: "."), dot != last.startIndex else { return false }
                let ext = last[last.index(after: dot)...]
                return (1...8).contains(ext.count) && ext.first!.isLetter && ext.allSatisfy { $0.isLetter || $0.isNumber }
            }()
            if prefixed || absolute {
                // `/` alone, `/2`, or `/ and` are not paths; a route like `/state` or a folder `~/x` is.
                guard segments.count >= 2, !last.isEmpty || segments.count > 2 else { return nil }
                if absolute, !prefixed, segments.count == 2, !hasExt, last.count < 2 { return nil }
            } else {
                guard hasExt, !segments.contains(where: { $0.isEmpty }) else { return nil }
                // Version-like `1.2/3.4` and dates are not paths.
                if !segments.contains(where: { $0.contains(where: { $0.isLetter }) }) { return nil }
            }
            return (t, end)
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
