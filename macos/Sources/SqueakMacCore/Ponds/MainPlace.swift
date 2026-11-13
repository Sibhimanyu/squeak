import Foundation

/// Main: a git pond's own folder, the place chats start in by default. A Main chat's `cwd` is the pond's root and it has
/// no stream (the same model as a plain-folder pond's chats). Pure rules; the sidebar, New thread and the inspector draw them.
public struct MainPlace: Equatable, Sendable {
    public var projectId: String
    public var pondName: String
    public var rootPath: String
    /// The branch the root is on (a detached head is its short sha); nil when the host did not say.
    public var branch: String?

    public init(projectId: String, pondName: String, rootPath: String, branch: String? = nil) {
        self.projectId = projectId; self.pondName = pondName; self.rootPath = rootPath; self.branch = branch
    }

    /// Only a git pond has a Main place; a plain folder just runs chats in the folder.
    public init?(project: NativeProject) {
        guard !project.isPlainFolder else { return nil }
        self.init(projectId: project.id, pondName: project.name, rootPath: project.rootPath, branch: project.mainBranch)
    }

    public static let name = "Main"

    /// Plain "Main", whatever branch the root is on (a branch is never listed; it shows as a stream or not at all).
    public var label: String { Self.label(branch: branch) }

    public static func label(branch: String? = nil) -> String { name }

    /// The same folder, whatever the spelling (a trailing slash, a `.` or `..` step).
    public static func samePath(_ a: String?, _ b: String?) -> Bool {
        guard let a, let b, !a.isEmpty, !b.isEmpty else { return false }
        func norm(_ p: String) -> String { (URL(fileURLWithPath: p).standardizedFileURL.path as NSString).standardizingPath }
        return norm(a) == norm(b)
    }

    /// A chat runs in Main when its folder is the pond's root.
    public func contains(_ session: HostSession) -> Bool { Self.samePath(session.cwd, rootPath) }

    /// The chat that holds Main right now: working, with background work, or waiting on the person. `isActive` is the
    /// sidebar's own notion of working; waiting (blocked) counts because the chat still owns the folder.
    public func busyChat(in sessions: [HostSession]) -> HostSession? {
        sessions.filter { contains($0) && $0.archivedAt == nil && Self.isBusy($0) }
            .max { ($0.lastActivityAt ?? .distantPast) < ($1.lastActivityAt ?? .distantPast) }
    }

    public static func isBusy(_ s: HostSession) -> Bool { s.alive != false && (s.isActive || s.state == .blocked) }

    /// The one line above the composer when ⌘N meets a busy Main.
    public static func busyOffer(title: String) -> String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Main is busy with \u{2018}\(t.isEmpty ? "another chat" : t)\u{2019}. Start in a new stream?"
    }
    public static let offerNewStream = "New stream"
    public static let offerStay = "Stay in Main"
}

/// Where a new, unsent chat starts: the "In:" control above the composer.
public enum NewChatIn {
    /// ⌘N and a pond's Start a thread begin in Main when the pond has one; a named stream (a stream's "+") stays
    /// there; a pond with no Main (a plain folder, or none known) falls back to the newest stream, else a new one.
    public static func defaultChoice(hasMain: Bool, requestedStream: String?, newestStream: String?) -> StartThreadStream {
        if let requestedStream { return .existing(requestedStream) }
        if hasMain { return .main }
        return newestStream.map { .existing($0) } ?? .new
    }

    /// "Main", a stream's title, or "New stream" for the control's label.
    public static func label(_ choice: StartThreadStream, main: MainPlace?, streams: [NativeWorkspace]) -> String {
        switch choice {
        case .main: main?.label ?? MainPlace.name
        case .existing(let id): streams.first { $0.id == id }?.displayTitle ?? "New stream"
        case .new: "New stream"
        }
    }

    /// What the busy offer does to the choice: "New stream" switches, "Stay in Main" keeps Main and hides the offer.
    public struct Offer: Equatable, Sendable {
        public var dismissed = false
        public init() {}
        public func shows(choice: StartThreadStream, busy: HostSession?) -> Bool { !dismissed && choice == .main && busy != nil }
    }
}
