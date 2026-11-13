import Foundation

// Where a clicked path goes. Every path opens inside Squeak: a text file or an image in a tab of the chat's workspace,
// a folder in the Files tab (or a listing tab when it is outside), any other file in a Quick Look preview. A path that
// is not there opens nothing and says so. Finder and the default app are explicit menu choices, never a click.

public enum PathDestination: Equatable, Sendable {
    /// Nothing is there (the file name, for the toast).
    case notFound(name: String)
    /// `relative` is the path under the chat's folder ("" for the folder itself), nil when it is outside it.
    case folder(URL, relative: String?)
    case image(URL, relative: String?)
    /// A file that is not an image. Text opens in the viewer (at `line`); a binary one, or one too big to read as text,
    /// is decided when it is read (`PathRouting.viewer(name:size:head:)`) and shown in a preview.
    case file(URL, relative: String?, line: Int?)

    public var url: URL? {
        switch self {
        case .notFound: nil
        case .folder(let u, _), .image(let u, _), .file(let u, _, _): u
        }
    }

    /// Outside the chat's folder: opened read-only, by its full path.
    public var isOutside: Bool {
        switch self {
        case .notFound: false
        case .folder(_, let r), .image(_, let r), .file(_, let r, _): r == nil
        }
    }
}

/// What the viewer shows for a file once its first bytes are known.
public enum FileViewerKind: Equatable, Sendable { case text, image, preview }

public enum PathRouting {
    /// The path under `root` ("" for the root itself), or nil when it is outside.
    public static func inside(_ url: URL, root: String) -> String? {
        let base = URL(fileURLWithPath: root).standardizedFileURL.path
        let p = url.standardizedFileURL.path
        if p == base { return "" }
        guard p.hasPrefix(base + "/") else { return nil }
        return String(p.dropFirst(base.count + 1))
    }

    public static func destination(url: URL, state: PathExistenceCache.State, line: Int?, cwd: String) -> PathDestination {
        let rel = inside(url, root: cwd)
        switch state {
        case .missing: return .notFound(name: url.lastPathComponent)
        case .exists(let isDirectory) where isDirectory: return .folder(url, relative: rel)
        case .exists, .unknown:
            return PathLinking.isImage(url) ? .image(url, relative: rel) : .file(url, relative: rel, line: line)
        }
    }

    /// Text, an image, or a preview for what the first bytes say (`FileKind.classify`'s rules, so a NUL byte, invalid
    /// UTF-8, over 2 MB of text or over 25 MB of image all go to a preview).
    public static func viewer(name: String, size: Int64, head: Data) -> FileViewerKind {
        switch FileKind.classify(name: name, size: size, head: head) {
        case .text: .text
        case .image: .image
        case .external: .preview
        }
    }

    /// The line a link names, kept when it is a plain positive number (a `file.swift:0` scrolls nowhere).
    public static func line(_ n: Int?) -> Int? { n.flatMap { $0 > 0 ? $0 : nil } }

    /// A file:// URL or a bare path from a message link (`[a](src/a.ts:3)`), as the text a path parse reads; nil for
    /// anything with another scheme (http, https, mailto, squeak): those are not paths.
    public static func pathText(fromLink url: URL) -> String? {
        if url.scheme == "file" { return url.path.isEmpty ? nil : url.path }
        guard url.scheme == nil else { return nil }
        return url.absoluteString.removingPercentEncoding ?? url.absoluteString
    }
}
