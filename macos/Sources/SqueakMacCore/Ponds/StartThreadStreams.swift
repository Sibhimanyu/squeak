import Foundation

/// Which stream a pond's own thread starts in (the Start a thread sheet's picker).
public enum StartThreadStream: Equatable, Sendable {
    case new
    case existing(String)

    /// The `workspaceId` the host route takes; nil = a new stream.
    public var workspaceId: String? {
        if case .existing(let id) = self { id } else { nil }
    }
}

public enum StartThreadStreams {
    /// The project's streams on this Mac a thread can start in, newest activity first (a stream's newest chat, else when
    /// it was made); archived ones are gone. Ties keep the given order.
    public static func options(_ workspaces: [NativeWorkspace], projectId: String?, lastActive: [String: Date] = [:]) -> [NativeWorkspace] {
        guard let projectId else { return [] }
        func stamp(_ w: NativeWorkspace) -> Date { max(lastActive[w.id] ?? .distantPast, w.createdAt ?? .distantPast) }
        let mine = workspaces.enumerated().filter { $0.element.projectId == projectId && $0.element.state != "archived" }
        return mine.sorted { a, b in
            let (x, y) = (stamp(a.element), stamp(b.element))
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
    }

    /// The most recently active stream, or a new one when there are none.
    public static func defaultChoice(_ options: [NativeWorkspace]) -> StartThreadStream {
        options.first.map { .existing($0.id) } ?? .new
    }

    /// A plain folder has no streams, so the picker is hidden and the thread runs in the folder.
    public static func showsPicker(isGitFolder: Bool) -> Bool { isGitFolder }

    /// A choice that no longer exists (the stream was archived while the sheet was open) falls back to the default.
    public static func valid(_ choice: StartThreadStream, in options: [NativeWorkspace]) -> StartThreadStream {
        if case .existing(let id) = choice, !options.contains(where: { $0.id == id }) { return defaultChoice(options) }
        return choice
    }
}

/// What a pond's "Start a thread" carries into the normal New thread page: the pond, its project, the stream
/// preselected (`StartThreadStreams.defaultChoice`) and whether the thread is private to its starter.
public struct PondThreadContext: Equatable, Sendable {
    public var pondId: String
    public var pondName: String
    public var projectId: String
    public var choice: StartThreadStream
    /// False for a plain folder (no streams): the thread runs in the folder, the host decides.
    public var showsPicker: Bool
    public var isPrivate = false

    /// "Shared with <pond> · everyone in the pond can see it", or the private sentence.
    public var shareLine: String { PondThreadEntry.shareLine(pond: pondName, isPrivate: isPrivate) }
}

public enum PondThreadEntry: Equatable, Sendable {
    case open(page: NewPage, context: PondThreadContext)
    /// The pond cannot start a thread here; the button says why.
    case refuse(why: String)

    public static func shareLine(pond: String, isPrivate: Bool) -> String {
        isPrivate ? "Private \u{00B7} only you can see it in \(pond)" : "Shared with \(pond) \u{00B7} everyone in the pond can see it"
    }

    /// Which page a pond's Start a thread opens and what it preselects. A plain folder (no stream has a branch) gets no
    /// picker; otherwise the newest stream, or a new one when there is none.
    /// `projectKind` is the host's word for the project (`git` or `folder`); without it a project with no stream that has
    /// a branch is read as a plain folder, as an older host needs.
    public static func resolve(pond: PondSummary, workspaces: [NativeWorkspace], lastActive: [String: Date] = [:], projectKind: String? = nil) -> PondThreadEntry {
        switch PondStartThread.offer(for: pond) {
        case .none: return .refuse(why: "Viewers can\u{2019}t start threads.")
        case .shareOnly(let why): return .refuse(why: why)
        case .start: break
        }
        guard let projectId = pond.projectId else { return .refuse(why: PondStartThread.noRemote) }
        let mine = workspaces.filter { $0.projectId == projectId }
        let isGit = projectKind.map { $0 != "folder" } ?? mine.contains { !$0.branch.isEmpty }
        let options = StartThreadStreams.options(workspaces, projectId: projectId, lastActive: lastActive)
        let choice = isGit ? StartThreadStreams.defaultChoice(options) : .new
        let page = NewPage.thread(projectId: projectId, workspaceId: choice.workspaceId)
        return .open(page: page, context: PondThreadContext(
            pondId: pond.id, pondName: pond.name, projectId: projectId, choice: choice,
            showsPicker: StartThreadStreams.showsPicker(isGitFolder: isGit)))
    }
}
