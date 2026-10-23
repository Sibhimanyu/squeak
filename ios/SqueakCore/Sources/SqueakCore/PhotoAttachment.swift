import Foundation

/// A photo sent with a message. The phone cannot attach a file to a Conductor chat (Conductor's relay refuses
/// attachments), so it does what Conductor itself does: the photo is saved by the Mac under the chat's
/// `.context/attachments/`, and the message names the path, one `[Image: …]` line per photo, which the agent
/// reads. The phone shows those lines as photos, never as text.
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

    public static func line(for ref: String) -> String { "[Image: \(ref)]" }

    /// What is sent: the person's words, then one line per saved photo. With no words, a plain request to look.
    public static func compose(_ text: String, refs: [String]) -> String {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !refs.isEmpty else { return words }
        let lead = words.isEmpty ? (refs.count == 1 ? "See the attached image." : "See the attached images.") : words
        return ([lead, ""] + refs.map(line(for:))).joined(separator: "\n")
    }

    private static let pattern = try! NSRegularExpression(pattern: #"^\[Image: (\.context/attachments/[0-9a-f]{8}/image-\d+\.(?:jpg|png))\]$"#)

    /// A message's words and the photos it names, for showing: the marker lines are taken out of the text.
    public static func split(_ text: String) -> (body: String, refs: [String]) {
        var kept: [Substring] = []
        var refs: [String] = []
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let range = NSRange(line.startIndex..., in: line)
            if let match = pattern.firstMatch(in: String(line), range: range), let found = Range(match.range(at: 1), in: line) {
                refs.append(String(line[found]))
            } else {
                kept.append(line)
            }
        }
        guard !refs.isEmpty else { return (text, []) }
        return (kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines), refs)
    }
}
