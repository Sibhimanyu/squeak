import Foundation

/// One tab of a Pond's strip, by identity: a Duck (its Duck id, so the tab follows the Duck to its newest chat), a file,
/// a canvas or artifact, or a duckling the person clicked. Never a chat key, except for a chat no Duck owns (`chat:<key>`).
public struct TabItem: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case duck, file, artifact, duckling, diff, reviewAll, notebook }
    public var kind: Kind
    public var id: String
    /// The Stream a diff or review tab reads (ADR 0003: a Duck runs in the Pond's folder and edits in joined Streams, so its
    /// chat's folder says nothing about a Stream's files). Absent on a tab saved before Streams, or for a Duck outside any
    /// Stream: that tab reads through the Duck's chat as it always did.
    public var stream: TabStream?
    public init(_ kind: Kind, _ id: String, stream: TabStream? = nil) { self.kind = kind; self.id = id; self.stream = stream }

    /// A Duck's tab, by its Duck id (or `chat:<key>`, see `duckID(of:)`).
    public static func duck(_ id: String) -> TabItem { TabItem(.duck, id) }
    public static func file(_ id: String) -> TabItem { TabItem(.file, id) }
    /// A file in a Pond may belong to any of its Streams, or be shown from outside the Stream.
    public static func pondFile(root: String, path: String) -> TabItem { .file(ScopedTabID.make(root, path)) }
    public static func diff(session: String, path: String, stream: TabStream? = nil) -> TabItem {
        TabItem(.diff, ScopedTabID.make(session, path), stream: stream)
    }
    public static func reviewAll(session: String, stream: TabStream? = nil) -> TabItem { TabItem(.reviewAll, session, stream: stream) }
    public static let notebook = TabItem(.notebook, "notebook")

    public var fileSource: (root: String, path: String)? {
        guard kind == .file else { return nil }
        return ScopedTabID.parse(id).map { ($0.scope, $0.path) }
    }

    /// The Duck's chat, the file (nil for review-all) and the Stream every reader resolves diffs, status, merge and PR by.
    public var diffSource: (session: String, path: String?, stream: TabStream?)? {
        switch kind {
        case .diff: ScopedTabID.parse(id).map { ($0.scope, $0.path, stream) }
        case .reviewAll: (id, nil, stream)
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

/// A Stream by its host workspace id, with its branch for the header. What a diff or review tab carries beside the Duck.
public struct TabStream: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var branch: String
    public init(workspaceId: String, branch: String) { self.workspaceId = workspaceId; self.branch = branch }
}

extension TabStream {
    /// The Stream a diff opened from a place that does not name one belongs to: the Duck's only Stream, else the one whose
    /// changed files include `path`, else its first. nil when the Duck is in none (it then reads through its chat).
    public static func resolve(streams: [RoomStream], changedPaths: [String: [String]], path: String?) -> TabStream? {
        guard let first = streams.first else { return nil }
        let pick = streams.count > 1
            ? (path.flatMap { p in streams.first { changedPaths[$0.workspaceId]?.contains(p) == true } } ?? first) : first
        return TabStream(workspaceId: pick.workspaceId, branch: pick.branch)
    }
}

/// How a diff or review tab's readers reach its files: through the Stream's folder when the tab carries one, else through
/// the Duck's chat (a tab saved before Streams, or a Duck outside any Stream). One decision for every reader (changes,
/// patches, git status, merge, PR), so none can fall back to the chat's folder by accident.
public enum DiffRoute: Equatable, Sendable {
    case stream(workspaceId: String)
    case chat(sessionKey: String)

    public init(session: String, stream: TabStream?) {
        if let stream, !stream.workspaceId.isEmpty { self = .stream(workspaceId: stream.workspaceId) } else { self = .chat(sessionKey: session) }
    }

    public init?(_ item: TabItem) {
        guard let source = item.diffSource else { return nil }
        self.init(session: source.session, stream: source.stream)
    }

    /// The key a read cache is kept under: distinct per Stream, so one Duck's two Streams never share a list.
    public var cacheKey: String {
        switch self {
        case .stream(let id): "stream:\(id)"
        case .chat(let key): key
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
