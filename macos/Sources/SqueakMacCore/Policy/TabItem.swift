import Foundation

/// One tab of a Pond's strip, by identity: a Duck (its Duck id, so the tab follows the Duck to its newest chat), a file,
/// a canvas or artifact, or a duckling the person clicked. Never a chat key, except for a chat no Duck owns (`chat:<key>`).
public struct TabItem: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case duck, file, artifact, duckling }
    public var kind: Kind
    public var id: String
    public init(_ kind: Kind, _ id: String) { self.kind = kind; self.id = id }

    /// A Duck's tab, by its Duck id (or `chat:<key>`, see `duckID(of:)`).
    public static func duck(_ id: String) -> TabItem { TabItem(.duck, id) }
    public static func file(_ id: String) -> TabItem { TabItem(.file, id) }
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
    private static let separator: Character = "\u{1F}"
    public static func make(pond: String, path: String) -> String { "\(pond)\(separator)\(path)" }
    public static func parse(_ id: String) -> (pond: String, path: String)? {
        guard let at = id.firstIndex(of: separator) else { return nil }
        return (String(id[..<at]), String(id[id.index(after: at)...]))
    }
}
