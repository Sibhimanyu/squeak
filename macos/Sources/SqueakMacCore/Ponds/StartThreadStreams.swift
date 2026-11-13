import Foundation

/// Which stream a pond's own thread starts in (the Start a thread sheet's picker).
public enum StartThreadStream: Equatable, Sendable {
    case new
    case existing(String)
    /// The pond's own folder (`MainPlace`): no stream is made.
    case main

    /// The `workspaceId` the host route takes; nil = a new stream, or Main (see `isMain`).
    public var workspaceId: String? {
        if case .existing(let id) = self { id } else { nil }
    }

    public var isMain: Bool { self == .main }
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

    /// The most recently active stream, or a new one when there are none (a pond without a Main place).
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
    /// Set on a pond someone shared with me: the owner's name, so the thread can run on their Mac ("Runs on Sibhi's Mac"). Nil on a
    /// pond of mine.
    public var ownerMac: String?
    /// The thread runs on the owner's Mac: a signed `start` request, no stream and no model or permission choice beyond the
    /// pond's. True when the pond has nothing to run it here, or when the person picks it.
    public var runsOnOwner = false
    /// A shared pond that could run the thread here too (it has a Git remote and this Mac has the project): the place menu offers both.
    public var canRunHere = true

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
    ///
    /// A git pond starts in Main (its own folder) by default; `hasMain: false` (an older host, or no Main known) keeps the
    /// newest stream.
    public static func resolve(pond: PondSummary, workspaces: [NativeWorkspace], lastActive: [String: Date] = [:], projectKind: String? = nil,
                               hasMain: Bool = false) -> PondThreadEntry {
        let shared = PondSharing.isSharedWithMe(pond)
        switch PondStartThread.offer(for: pond) {
        case .none: return .refuse(why: "Viewers can\u{2019}t start threads.")
        case .shareOnly(let why):
            // Someone else's pond that this Mac cannot start in: the thread runs on the owner's Mac (a signed request).
            guard shared else { return .refuse(why: why) }
            return .open(page: .thread(projectId: nil, workspaceId: nil), context: ownerContext(pond))
        case .start: break
        }
        guard let projectId = pond.projectId else { return .refuse(why: PondStartThread.noRemote) }
        let mine = workspaces.filter { $0.projectId == projectId }
        let isGit = projectKind.map { $0 != "folder" } ?? mine.contains { !$0.branch.isEmpty }
        let options = StartThreadStreams.options(workspaces, projectId: projectId, lastActive: lastActive)
        let choice = isGit ? NewChatIn.defaultChoice(hasMain: hasMain, requestedStream: nil, newestStream: options.first?.id) : .new
        let page = NewPage.thread(projectId: projectId, workspaceId: choice.workspaceId)
        var context = PondThreadContext(
            pondId: pond.id, pondName: pond.name, projectId: projectId, choice: choice,
            showsPicker: StartThreadStreams.showsPicker(isGitFolder: isGit))
        // A pond shared with me can also run the thread on the owner's Mac; this Mac is the default.
        if shared { context.ownerMac = PondSharing.sharerName(pond) ?? "" }
        return .open(page: page, context: context)
    }

    /// A shared pond's thread that runs on the owner's Mac and nowhere else.
    static func ownerContext(_ pond: PondSummary) -> PondThreadContext {
        var c = PondThreadContext(pondId: pond.id, pondName: pond.name, projectId: pond.projectId ?? "", choice: .new, showsPicker: false)
        c.ownerMac = PondSharing.sharerName(pond) ?? ""
        c.runsOnOwner = true
        c.canRunHere = false
        return c
    }
}
