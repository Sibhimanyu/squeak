import Foundation

/// Pictures (and files) that sit inside a message where they were pasted. The stored text is Conductor's token,
/// `@⟦name⟧(url-encoded path)`, at the place it belongs, so the agent reads the words around it (the host also sends the
/// picture itself right after the token, `src/native/inline-images.ts`). The composer draws each token as one inline chip:
/// in the text view a token is a single attachment character (U+FFFC), so the caret steps over it, Backspace takes it
/// whole and it wraps with the words; `display` and `storage` map between the two.
///
/// A picture not yet saved (it is saved only when the message is sent) carries a pending path, `squeak-pending:<id>`,
/// which `resolve` replaces with the saved path in place.
public enum InlineAttachments {
    public struct Token: Equatable, Hashable, Sendable {
        /// The token exactly as stored.
        public let raw: String
        /// What the chip shows: "image-1.png", "Screenshot 2026-11-26.png".
        public let name: String
        /// The decoded path (relative to the chat's folder, or absolute), or `squeak-pending:<id>`.
        public let path: String

        public var pendingId: String? { path.hasPrefix(pendingScheme) ? String(path.dropFirst(pendingScheme.count)) : nil }
        public var isImage: Bool {
            let ext = (name.split(separator: ".").last.map(String.init) ?? "").lowercased()
            let pathExt = (path.split(separator: ".").last.map(String.init) ?? "").lowercased()
            return pendingId != nil || imageExtensions.contains(ext) || imageExtensions.contains(pathExt)
        }
    }

    public enum Segment: Equatable, Sendable {
        case text(String)
        case token(Token)
    }

    public static let pendingScheme = "squeak-pending:"
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff"]
    /// The attachment character the text view holds in a token's place.
    public static let attachmentCharacter: Character = "\u{FFFC}"

    private static let pattern = try! NSRegularExpression(pattern: #"@⟦([^⟦⟧\n]*)⟧\(([^)\s]+)\)"#)

    /// A token for `name` at `path` (encoded the way Conductor and the phone do).
    public static func token(name: String, path: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let safeName = name.replacingOccurrences(of: "⟦", with: "").replacingOccurrences(of: "⟧", with: "")
            .replacingOccurrences(of: "\n", with: " ")
        return "@⟦\(safeName)⟧(\(path.addingPercentEncoding(withAllowedCharacters: allowed) ?? path))"
    }

    /// A picture waiting to be saved: its chip shows `name`; `resolve` gives it its saved path at send.
    public static func pendingToken(name: String, id: String) -> String { token(name: name, path: pendingScheme + id) }

    /// The text cut into words and tokens, in order. Text with no token is one `.text` (or none when empty).
    public static func segments(_ text: String) -> [Segment] {
        guard text.contains("@⟦") else { return text.isEmpty ? [] : [.text(text)] }
        var out: [Segment] = []
        let ns = text as NSString
        var from = 0
        for m in pattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > from { out.append(.text(ns.substring(with: NSRange(location: from, length: m.range.location - from)))) }
            let encoded = ns.substring(with: m.range(at: 2))
            out.append(.token(Token(raw: ns.substring(with: m.range), name: ns.substring(with: m.range(at: 1)),
                                    path: encoded.removingPercentEncoding ?? encoded)))
            from = m.range.location + m.range.length
        }
        if from < ns.length { out.append(.text(ns.substring(from: from))) }
        return out
    }

    public static func tokens(in text: String) -> [Token] {
        segments(text).compactMap { if case .token(let t) = $0 { t } else { nil } }
    }

    /// What the text view holds: each token replaced by one attachment character, and the tokens in order.
    public struct Display: Equatable, Sendable {
        public var string: String
        public var tokens: [Token]
    }

    public static func display(_ text: String) -> Display {
        var s = "", tokens: [Token] = []
        for seg in segments(text) {
            switch seg {
            case .text(let t): s += t
            case .token(let t): s.append(attachmentCharacter); tokens.append(t)
            }
        }
        return Display(string: s, tokens: tokens)
    }

    /// The stored text back from what the view holds: each attachment character, in order, is the next token.
    /// An attachment character with no token left (cannot happen from `display`) is dropped.
    public static func storage(_ display: String, tokens: [Token]) -> String {
        var out = "", i = 0
        for c in display {
            if c == attachmentCharacter {
                if i < tokens.count { out += tokens[i].raw }
                i += 1
            } else {
                out.append(c)
            }
        }
        return out
    }

    /// The display (UTF-16) offset of a storage offset: where the caret goes after the text is rebuilt.
    public static func displayOffset(ofStorage offset: Int, in text: String) -> Int {
        let ns = text as NSString
        let prefix = ns.substring(to: min(max(0, offset), ns.length))
        return (display(prefix).string as NSString).length
    }

    /// The pending pictures still named in the text, in order.
    public static func pendingIds(in text: String) -> [String] { tokens(in: text).compactMap(\.pendingId) }

    /// Takes a pending picture out of the text (it could not be read).
    public static func removing(pendingId id: String, from text: String) -> String {
        segments(text).map {
            switch $0 {
            case .text(let t): t
            case .token(let t): t.pendingId == id ? "" : t.raw
            }
        }.joined()
    }

    /// The text to send: each pending token replaced in place by its saved path (`refs`: pending id to path relative to the
    /// chat's folder), keeping the name the chip showed. A pending token with no saved file is dropped. When only pictures
    /// are left, a plain line asks the agent to look, as `ImageAttachments.compose` does.
    public static func resolve(_ text: String, refs: [String: String]) -> String {
        let body = segments(text).map { seg -> String in
            switch seg {
            case .text(let t): return t
            case .token(let t):
                guard let id = t.pendingId else { return t.raw }
                return refs[id].map { token(name: t.name, path: $0) } ?? ""
            }
        }.joined().trimmingCharacters(in: .whitespacesAndNewlines)
        let words = segments(body).compactMap { if case .text(let t) = $0 { t } else { nil } }.joined()
        guard words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return body }
        let n = tokens(in: body).count
        guard n > 0 else { return body }
        return (n == 1 ? "See the attached image." : "See the attached images.") + "\n\n" + body
    }

    /// The chip's name, shortened in the middle so the extension stays: "Screenshot 2026-1…26.png".
    public static func chipName(_ name: String, maxCharacters: Int = 22) -> String {
        guard name.count > maxCharacters, maxCharacters > 4 else { return name }
        let tail = min(8, maxCharacters / 2)
        return String(name.prefix(maxCharacters - tail - 1)) + "\u{2026}" + String(name.suffix(tail))
    }

    /// What a sent message flows in: words (each with the space after it, so wrapping happens between words), line
    /// breaks, and chips where the tokens were.
    public enum Piece: Equatable, Sendable { case word(String), newline, token(Token) }

    public static func pieces(_ text: String) -> [Piece] {
        var out: [Piece] = []
        for seg in segments(text) {
            switch seg {
            case .token(let t): out.append(.token(t))
            case .text(let s):
                for (i, line) in s.components(separatedBy: "\n").enumerated() {
                    if i > 0 { out.append(.newline) }
                    var word = ""
                    for c in line {
                        word.append(c)
                        if c == " " { out.append(.word(word)); word = "" }
                    }
                    if !word.isEmpty { out.append(.word(word)) }
                }
            }
        }
        return out
    }
}
