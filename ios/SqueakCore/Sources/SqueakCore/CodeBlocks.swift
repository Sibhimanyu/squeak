import Foundation

/// The fenced code blocks of a message (commands, config, YAML), whole and in order, for the "Copy" rows: what an
/// agent says to copy is almost always inside one. The fence lines and the language tag are not part of the text.
public enum MessageCodeBlocks {
    public static func blocks(in text: String, limit: Int = 6) -> [String] {
        var out: [String] = []
        var cur: [Substring] = []
        var fence: Character?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let t = line.drop(while: { $0 == " " })
            if t.hasPrefix("```") || t.hasPrefix("~~~") {
                if fence == nil {
                    fence = t.first
                    cur = []
                } else if fence == t.first {
                    let body = cur.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !body.isEmpty { out.append(body) }
                    fence = nil
                    if out.count >= limit { return out }
                }
            } else if fence != nil {
                cur.append(line)
            }
        }
        return out
    }
}
