import Foundation

/// The creation pages the centre can show (the New pond, New branch and New thread pages, and the quick message).
public enum ComposePage: String, Codable, Equatable, Hashable, Sendable {
    case quickMessage, newPond, newBranch, newThread
}

/// What the centre shows: one value, never three combined by `if`. Pond keys are directory keys (a project's id, or a
/// joined pond's own id), never names.
public enum WorkbenchLocation: Equatable, Hashable, Codable, Sendable {
    /// The Dashboard.
    case home
    case pondHome(pond: String)
    /// Another member's thread, or one of the pond's own, opened from its home.
    case pondThread(pond: String, pondId: String, threadId: String)
    case pondSettings(pond: String)
    /// Every archived thread across all ponds.
    case archived
    case chat(SessionKey)
    /// A creation page and the pond (directory key) and workspace it targets, when it targets one.
    case compose(ComposePage, pond: String?, workspace: String?)
    /// A Settings page (Settings is a layer over the workbench, never a separate window state).
    case settings(SettingsSection)
    /// The Usage screen.
    case usage
    /// An artifact opened full size in the centre, over whatever page or chat it was opened from (`path` is the file's
    /// absolute path, `pond` the pond's directory key).
    case artifact(pond: String, path: String)

    public var chatKey: SessionKey? { if case .chat(let k) = self { return k } else { return nil } }

    public var composePage: ComposePage? { if case .compose(let p, _, _) = self { return p } else { return nil } }

    /// A pond page: home, a thread opened from it, its settings, or Archived.
    public var isPondRoute: Bool {
        switch self {
        case .pondHome, .pondThread, .pondSettings, .archived: true
        case .home, .chat, .compose, .settings, .usage, .artifact: false
        }
    }

    /// The pond a pond page belongs to.
    public var pondKey: String? {
        switch self {
        case .pondHome(let p), .pondThread(let p, _, _), .pondSettings(let p), .artifact(let p, _): p
        case .compose(_, let p, _): p
        case .home, .archived, .chat, .settings, .usage: nil
        }
    }

    /// The location with any pond that is not `live` taken out: a page of a gone pond is the Dashboard. A nil `live`
    /// (the directory has not loaded) prunes nothing, so a slow start never wipes the places.
    public func prune(livePonds live: Set<String>?) -> WorkbenchLocation {
        guard let live, let key = pondKey, !live.contains(key) else { return self }
        return .home
    }

    /// Where the centre falls back to when a page over it closes: the open chat, else the Dashboard.
    public static func resting(chat: SessionKey?) -> WorkbenchLocation { chat.map { .chat($0) } ?? .home }

    /// The Settings page on screen, if any.
    public var settingsSection: SettingsSection? { if case .settings(let s) = self { return s } else { return nil } }

    public var isSettings: Bool { settingsSection != nil }

    public var isUsage: Bool { self == .usage }

    /// The artifact open in the centre, if any.
    public var artifactPath: String? { if case .artifact(_, let p) = self { return p } else { return nil } }

    public var isArtifact: Bool { artifactPath != nil }

    /// Back and forward remember every place but the quick message, which is a passing prompt.
    public var isRecorded: Bool {
        switch self {
        case .compose(.quickMessage, _, _): false
        default: true
        }
    }
}

/// The last chat open in each pond and in each workspace, so opening a pond (or a workspace) returns to where the
/// person was. Kept in UserDefaults; chats that are gone are pruned.
public struct PlaceMemory: Codable, Equatable, Sendable {
    public private(set) var pondChats: [String: SessionKey] = [:]
    public private(set) var workspaceChats: [String: SessionKey] = [:]

    public init() {}

    /// Notes a chat location against its pond and workspace. Anything but a chat is ignored.
    public mutating func remember(_ location: WorkbenchLocation, pond: String?, workspace: String?) {
        guard case .chat(let key) = location else { return }
        if let pond, !pond.isEmpty { pondChats[pond] = key }
        if let workspace, !workspace.isEmpty { workspaceChats[workspace] = key }
    }

    public func lastChat(pond: String) -> SessionKey? { pondChats[pond] }
    public func lastChat(workspace: String) -> SessionKey? { workspaceChats[workspace] }

    /// Forgets every chat that is not in `existing`.
    public mutating func prune(existing: Set<SessionKey>) {
        pondChats = pondChats.filter { existing.contains($0.value) }
        workspaceChats = workspaceChats.filter { existing.contains($0.value) }
    }

    /// Forgets every pond that is not in `live`. A nil `live` (directory not loaded) forgets nothing.
    public mutating func prune(livePonds live: Set<String>?) {
        guard let live else { return }
        pondChats = pondChats.filter { live.contains($0.key) }
    }

    public static let defaultsKey = "placeMemory"

    public static func load(_ defaults: UserDefaults = .standard) -> PlaceMemory {
        defaults.data(forKey: defaultsKey).flatMap { try? JSONDecoder().decode(PlaceMemory.self, from: $0) } ?? PlaceMemory()
    }

    public func save(_ defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) { defaults.set(data, forKey: Self.defaultsKey) }
    }
}
