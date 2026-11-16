import Foundation

/// How a tool approval reads on a card: decision first. The command or diff is clipped to a few lines with a
/// "Show all N lines" disclosure, and the Thread panel gets one line, never the body.
public enum ApprovalPresentation {
    public static let clipLines = 6

    public struct Clip: Equatable, Sendable {
        public var shown: String
        public var total: Int
        public var clipped: Bool
        public var hiddenLines: Int { max(0, total - shown.split(separator: "\n", omittingEmptySubsequences: false).count) }
    }

    /// The first `maxLines` lines of `text` (trailing blank lines ignored), and how many there are in all.
    public static func clip(_ text: String, maxLines: Int = clipLines) -> Clip {
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        while let last = lines.last, last.trimmingCharacters(in: .whitespaces).isEmpty, lines.count > 1 { lines.removeLast() }
        let total = lines.count
        guard total > maxLines else { return Clip(shown: lines.joined(separator: "\n"), total: total, clipped: false) }
        return Clip(shown: lines.prefix(maxLines).joined(separator: "\n"), total: total, clipped: true)
    }

    /// "Show all 61 lines".
    public static func disclosureTitle(total: Int, expanded: Bool) -> String {
        expanded ? "Show less" : "Show all \(total) lines"
    }

    /// What the tool does, in words: "run a command", "edit a file", "fetch a page".
    public static func action(tool: String?) -> String {
        switch tool ?? "" {
        case "Bash", "Command": return "run a command"
        case "Edit", "MultiEdit", "NotebookEdit": return "edit a file"
        case "Write": return "write a file"
        case "File change": return "change files"
        case "WebFetch": return "fetch a page"
        case "WebSearch": return "search the web"
        case "MCP": return "use a connected tool"
        case let t where t.isEmpty: return "use a tool"
        case let t: return "use \(t)"
        }
    }

    /// The card's title: "Claude wants to run a command".
    public static func title(agent: String, tool: String?) -> String { "\(agent) wants to \(action(tool: tool))" }

    /// The Thread panel's one line: "Approve: run a command · Bash".
    public static func compactLine(tool: String?) -> String {
        let a = action(tool: tool)
        guard let tool, !tool.isEmpty, a != "use \(tool)" else { return "Approve: \(a)" }
        return "Approve: \(a) · \(tool)"
    }

    /// A file's name for a header, from a path.
    public static func fileName(_ path: String) -> String { (path as NSString).lastPathComponent }

    /// An Edit's change as `-`/`+` lines (old then new), for the clipped preview.
    public static func diff(old: String?, new: String?) -> String? {
        let o = (old ?? "").isEmpty ? [] : (old ?? "").split(separator: "\n", omittingEmptySubsequences: false).map { "- \($0)" }
        let n = (new ?? "").isEmpty ? [] : (new ?? "").split(separator: "\n", omittingEmptySubsequences: false).map { "+ \($0)" }
        let all = o + n
        return all.isEmpty ? nil : all.joined(separator: "\n")
    }
}
