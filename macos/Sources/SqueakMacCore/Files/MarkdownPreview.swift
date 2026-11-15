import Foundation

/// Which files the file viewer can read as rendered Markdown, and which side it shows. Pure, so the rules are tested.
public enum MarkdownPreview {
    public enum Mode: String, Equatable, Sendable { case preview, source }

    private static let extensions: Set<String> = ["md", "markdown", "mdx"]

    /// `.md`, `.markdown` and `.mdx` (read as plain Markdown) get a Preview | Source switch.
    public static func isMarkdown(path: String) -> Bool {
        extensions.contains((path as NSString).pathExtension.lowercased())
    }

    /// What the tab shows: editing is always the source; otherwise the person's last pick for this file, Preview at first.
    public static func mode(editing: Bool, choice: Mode?) -> Mode {
        editing ? .source : (choice ?? .preview)
    }

    /// Picking Source or Preview while reading keeps reading; picking Source is not editing. Leaving edit returns to the
    /// last pick (`choice`), so Edit never overwrites it.
    public static func choice(afterPicking mode: Mode) -> Mode { mode }

    /// Whether the viewer shows the rendered side (a Markdown file, text content, not being edited).
    public static func showsPreview(path: String, editing: Bool, choice: Mode?) -> Bool {
        isMarkdown(path: path) && mode(editing: editing, choice: choice) == .preview
    }

    /// An image's source in the Markdown, resolved against the file's folder. Remote and `data:` sources are not fetched.
    /// With a `root` (the workspace folder) a source that resolves outside it (`../../x.png`, an absolute path, a
    /// symlink out) is refused, so a Markdown file cannot make the viewer read other folders.
    public static func localImageURL(source: String, fileURL: URL, root: URL? = nil) -> URL? {
        let s = source.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, !s.contains("://"), !s.hasPrefix("data:"), !s.hasPrefix("//") else { return nil }
        let decoded = s.removingPercentEncoding ?? s
        let url: URL = decoded.hasPrefix("/")
            ? URL(fileURLWithPath: decoded).standardizedFileURL
            : URL(fileURLWithPath: decoded, relativeTo: fileURL.deletingLastPathComponent()).standardizedFileURL
        guard let root else { return url }
        let base = root.resolvingSymlinksInPath().standardizedFileURL.path
        let real = url.resolvingSymlinksInPath().standardizedFileURL.path
        return real == base || real.hasPrefix(base.hasSuffix("/") ? base : base + "/") ? url : nil
    }
}

/// Where the reader is in a Markdown file, kept as a source line so Preview and Source can hand the place to each
/// other. The rendered side's height is not known here, so each source line carries a weight for about how much room
/// it takes rendered (a heading is taller than a blank line, an image far taller than a line of code, a long
/// paragraph line wraps); the position is the weight above the line over the weight of the whole file. Good enough to
/// land near the same heading or paragraph, never a pixel promise.
public enum MarkdownAnchor {
    /// Rendered weight of every line, in source order.
    public static func weights(_ text: String) -> [Double] {
        var inFence = false
        return text.split(separator: "\n", omittingEmptySubsequences: false).map { raw in
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") { inFence.toggle(); return 0.6 }
            if inFence { return 0.9 }
            if line.isEmpty { return 0.35 }
            if line.hasPrefix("#") {
                let level = line.prefix { $0 == "#" }.count
                return level <= 1 ? 3.2 : level == 2 ? 2.6 : 2.0
            }
            if line.hasPrefix("![") { return 10 }
            if line.hasPrefix("|") { return 1.3 }
            if line.hasPrefix("---") || line.hasPrefix("***") || line.hasPrefix("___") { return 1.0 }
            return max(1.0, (Double(line.count) / 95).rounded(.up))
        }
    }

    /// 0...1: how far down the file the top of `line` (1-based) sits.
    public static func fraction(ofLine line: Int, in text: String) -> Double {
        let w = weights(text)
        let total = w.reduce(0, +)
        guard total > 0, line > 1 else { return 0 }
        let above = w.prefix(min(line - 1, w.count)).reduce(0, +)
        return min(1, above / total)
    }

    /// The 1-based line whose top is at `fraction` of the way down: the inverse of `fraction(ofLine:in:)`.
    public static func line(atFraction fraction: Double, in text: String) -> Int {
        let w = weights(text)
        let total = w.reduce(0, +)
        guard total > 0, fraction > 0 else { return 1 }
        let target = min(1, fraction) * total
        var acc = 0.0
        for (i, x) in w.enumerated() {
            if acc + x > target { return i + 1 }
            acc += x
        }
        return max(1, w.count)
    }

    /// The nearest heading at or above `line`, for a caller that can place headings exactly.
    public static func heading(atOrAbove line: Int, in text: String) -> (line: Int, title: String)? {
        var found: (Int, String)?
        var inFence = false
        for (i, raw) in text.split(separator: "\n", omittingEmptySubsequences: false).enumerated() where i < line {
            let t = raw.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") || t.hasPrefix("~~~") { inFence.toggle(); continue }
            if !inFence, t.hasPrefix("#") { found = (i + 1, t.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces)) }
        }
        return found
    }
}
