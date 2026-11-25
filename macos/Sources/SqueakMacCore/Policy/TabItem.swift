import Foundation

/// One tab of a Pond's strip, by identity: a Duck (its Duck id, so the tab follows the Duck to its newest chat), a file,
/// a canvas or artifact, or a duckling the person clicked. Never a chat key, except for a chat no Duck owns (`chat:<key>`).
public struct TabItem: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case duck, file, artifact, duckling, diff, reviewAll, notebook }
    public var kind: Kind
    public var id: String
    public init(_ kind: Kind, _ id: String) { self.kind = kind; self.id = id }

    /// A Duck's tab, by its Duck id (or `chat:<key>`, see `duckID(of:)`).
    public static func duck(_ id: String) -> TabItem { TabItem(.duck, id) }
    public static func file(_ id: String) -> TabItem { TabItem(.file, id) }
    /// A file in a Pond may belong to any of its Streams, or be shown from outside the Stream.
    public static func pondFile(root: String, path: String) -> TabItem { .file(ScopedTabID.make(root, path)) }
    public static func diff(session: String, path: String) -> TabItem { TabItem(.diff, ScopedTabID.make(session, path)) }
    public static func reviewAll(session: String) -> TabItem { TabItem(.reviewAll, session) }
    public static let notebook = TabItem(.notebook, "notebook")

    public var fileSource: (root: String, path: String)? {
        guard kind == .file else { return nil }
        return ScopedTabID.parse(id).map { ($0.scope, $0.path) }
    }

    public var diffSource: (session: String, path: String?)? {
        switch kind {
        case .diff: ScopedTabID.parse(id).map { ($0.scope, $0.path) }
        case .reviewAll: (id, nil)
        default: nil
        }
    }

    var isPondItem: Bool {
        switch kind {
        case .file, .artifact, .diff, .reviewAll, .notebook: true
        case .duck, .duckling: false
        }
    }
    /// An artifact or canvas opened as a tab; `id` is `ArtifactTabID.make`.
    public static func artifact(pond: String, path: String) -> TabItem { TabItem(.artifact, ArtifactTabID.make(pond: pond, path: path)) }
    /// A duckling the person clicked: its parent chat and its task.
    public static func duckling(session: String, task: String) -> TabItem { TabItem(.duckling, "\(session)\u{1F}\(task)") }

    public static let chatPrefix = "chat:"
    /// The identity of the Duck a chat belongs to: its Duck id, else the chat itself (a session no Duck owns).
    public static func duckID(of session: HostSession) -> String { session.duckId ?? chatPrefix + session.key.stringValue }
    /// The tab of a chat: its Duck's.
    public static func of(_ session: HostSession) -> TabItem { .duck(duckID(of: session)) }
    /// The chat key behind a `chat:<key>` Duck identity; nil for a real Duck id.
    public var chatKey: String? { kind == .duck && id.hasPrefix(Self.chatPrefix) ? String(id.dropFirst(Self.chatPrefix.count)) : nil }

    /// The tab a dragged dock item is (a chat or a file); nil for panels, shells and ducklings, which are not in the strip.
    /// `duck` says which Duck identity a chat key stands for.
    public static func of(_ item: DockItem?, duck: (String) -> String = { chatPrefix + $0 }) -> TabItem? {
        switch item {
        case .thread(let k)?: return .duck(duck(k))
        case .file(let p)?: return .file(p)
        default: return nil
        }
    }
}

/// An artifact tab's id: its pond (directory key) and the file (an absolute path, or a remote pond's wire id).
public enum ArtifactTabID {
    public static func make(pond: String, path: String) -> String { ScopedTabID.make(pond, path) }
    public static func parse(_ id: String) -> (pond: String, path: String)? {
        ScopedTabID.parse(id).map { ($0.scope, $0.path) }
    }
}

private enum ScopedTabID {
    private static let separator: Character = "\u{1F}"
    static func make(_ scope: String, _ path: String) -> String { "\(scope)\(separator)\(path)" }
    static func parse(_ id: String) -> (scope: String, path: String)? {
        guard let at = id.firstIndex(of: separator) else { return nil }
        return (String(id[..<at]), String(id[id.index(after: at)...]))
    }
}
