import Foundation

/// A photo sent with a message. The phone cannot attach a file to a Conductor chat (Conductor's relay refuses
/// attachments), so it does what Conductor itself does: the photo is saved by the Mac under the chat's
/// `.context/attachments/`, and the message names the path in Conductor's own image token
/// (`@⟦image-1.jpg⟧(.context%2Fattachments%2F<id>%2Fimage-1.jpg)`), so Conductor draws it as an embedded image
/// and the agent reads the path. The phone shows those tokens, and the older `[Image: …]` lines, as photos.
public enum PhotoAttachment {
    /// A piece of a photo on the channel: a sealed command stays well inside the channel's size limit.
    public static let chunkBytes = 300_000
    public static let maxChunks = 4
    public static let maxPhotos = 4
    /// The most a prepared photo may weigh.
    public static let maxBytes = chunkBytes * maxChunks

    public static func chunks(of data: Data) -> [Data] {
        stride(from: 0, to: data.count, by: chunkBytes).map { data.subdata(in: $0..<min($0 + chunkBytes, data.count)) }
    }

    public static func line(for ref: String) -> String {
        let name = ref.split(separator: "/").last.map(String.init) ?? "image.jpg"
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        let encoded = ref.addingPercentEncoding(withAllowedCharacters: allowed) ?? ref
        return "@⟦\(name)⟧(\(encoded))"
    }

    /// What is sent: the person's words, then one line per saved photo. With no words, a plain request to look.
    public static func compose(_ text: String, refs: [String]) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !refs.isEmpty else { return words }
        let lead = words.isEmpty ? (refs.count == 1 ? "See the attached image." : "See the attached images.") : words
        return ([lead, ""] + refs.map(line(for:))).joined(separator: "\n")
    }

    private static let legacy = try! NSRegularExpression(pattern: #"^\[Image: (\.context/attachments/[0-9a-f]{8}/image-\d+\.(?:jpg|png))\]$"#)
    /// Conductor's own token: `@⟦name⟧(url-encoded path)`, anywhere in a line.
    private static let token = try! NSRegularExpression(pattern: #"@⟦[^⟦⟧\n]*⟧\(([^)\s]+)\)[ \t]*"#)
    private static let attachmentPath = try! NSRegularExpression(pattern: #"^\.context/attachments/[A-Za-z0-9_-]+/[^/\\]+\.(?:jpg|jpeg|png|gif|webp|heic)$"#, options: .caseInsensitive)

    private static func isAttachmentPath(_ path: String) -> Bool {
        attachmentPath.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)) != nil
    }

    /// A message's words and the photos it names, for showing: the markers are taken out of the text.
    public static func split(_ text: String) -> (body: String, refs: [String]) {
        var refs: [String] = []
        var kept: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let whole = String(line)
            if let match = legacy.firstMatch(in: whole, range: NSRange(whole.startIndex..., in: whole)),
               let found = Range(match.range(at: 1), in: whole) {
                refs.append(String(whole[found]))
                continue
            }
            var out = whole
            var found: [String] = []
            for match in token.matches(in: whole, range: NSRange(whole.startIndex..., in: whole)).reversed() {
                guard let path = Range(match.range(at: 1), in: whole),
                      let decoded = String(whole[path]).removingPercentEncoding, isAttachmentPath(decoded),
                      let all = Range(match.range, in: out) else { continue }
                found.insert(decoded, at: 0)
                out.removeSubrange(all)
            }
            refs += found
            kept.append(out)
        }
        guard !refs.isEmpty else { return (text, []) }
        return (kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), refs)
    }
}
