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
