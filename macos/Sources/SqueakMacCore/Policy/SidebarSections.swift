import Foundation

/// DESIGN.md §8.10 (sidebar, owner's correction 2026-11-09): the sidebar lists real projects only. Agent
/// sessions the fleet sees in other folders (a terminal in `.context/tab-release`, a headless run) are not
/// projects: they wait in one folded group at the bottom, "Other sessions".
public struct SidebarSections: Equatable, Sendable {
    public var projects: [SidebarProject]
    /// Chats of folders that are not projects, newest first.
    public var otherSessions: [HostSession]

    public static let otherTitle = "Other sessions"

    /// A project is real when Squeak runs chats in it (`nativeNames`, case-insensitive), or any chat in it
    /// belongs to Conductor or Squeak itself. A folder only terminals or headless runs have been seen in is not.
    public static func split(_ tree: SidebarTree, nativeNames: [String]) -> SidebarSections {
        let native = Set(nativeNames.map { $0.lowercased() })
        var real: [SidebarProject] = [], other: [HostSession] = []
        for p in tree.projects {
            let isReal = native.contains(p.name.lowercased())
                || p.workspaces.contains { $0.chats.contains { $0.source == .conductor || $0.source == .squeak } }
            if isReal { real.append(p) } else { other.append(contentsOf: p.workspaces.flatMap(\.chats)) }
        }
        return SidebarSections(projects: real, otherSessions: other.sorted(by: HomeProjects.before))
    }
}

/// A workspace row's diff stat, as the target draws it: "+5", "−205", "+3k", "−5.5k", "+8.4k", "+102k".
public enum DiffStatFormat {
    /// Under 1,000 as is; to 9,999 in thousands with one decimal ("3k", "5.5k"); beyond that whole thousands.
    public static func abbreviate(_ n: Int) -> String {
        let n = max(0, n)
        guard n >= 1000 else { return "\(n)" }
        if n < 10_000 {
            let tenths = (n + 50) / 100   // rounded to 0.1k
            return tenths % 10 == 0 ? "\(tenths / 10)k" : "\(tenths / 10).\(tenths % 10)k"
        }
        return "\((n + 500) / 1000)k"
    }
}

/// Back and forward between pages (⌘[ and ⌘]), as the sidebar's top bar offers: a stack of visited places, where
/// `nil` stands for the Home page. Visiting from the middle drops what was ahead; repeating the current place does nothing.
public struct NavHistory<Place: Equatable & Sendable>: Equatable, Sendable {
    private var places: [Place?] = []
    private var index = -1
    public static var limit: Int { 50 }

    public init() {}

    public var canGoBack: Bool { index > 0 }
    public var canGoForward: Bool { index >= 0 && index < places.count - 1 }

    public mutating func visit(_ place: Place?) {
        if index >= 0, places[index] == place { return }
        places.removeSubrange((index + 1)...)
        places.append(place)
        if places.count > Self.limit { places.removeFirst(places.count - Self.limit) }
        index = places.count - 1
    }

    /// The most recently visited place (not Home) that `isOpenable` still accepts: where "Home" returns to.
    public func lastVisited(where isOpenable: (Place) -> Bool) -> Place? {
        places.prefix(index + 1).reversed().compactMap { $0 }.first(where: isOpenable)
    }

    /// The place to open, or nil at the start. The outer optional is "is there one"; the inner is Home.
    public mutating func back() -> Place?? {
        guard canGoBack else { return nil }
        index -= 1
        return .some(places[index])
    }

    public mutating func forward() -> Place?? {
        guard canGoForward else { return nil }
        index += 1
        return .some(places[index])
    }
}

/// A git pond's Main row, the first under the pond (DESIGN.md §8.10): always there, with or without chats, ahead of the streams.
public enum MainSidebar {
    /// The pond's Main row: the one its chats already group under, else an empty one so a new chat can start there.
    /// Nil for a pond with no Main place (a plain folder).
    public static func row(main: MainPlace?, in workspaces: [SidebarWorkspace]) -> SidebarWorkspace? {
        guard let main else { return nil }
        if let existing = workspaces.first(where: \.isMain) { return existing }
        var w = SidebarWorkspace(
            id: "\(main.pondName)/\(main.rootPath)", name: (main.rootPath as NSString).lastPathComponent, title: nil,
            branch: main.branch, chats: [], repo: main.pondName, foldedMark: nil)
        w.isMain = true
        return w
    }

    /// The streams: every row but Main.
    public static func streams(_ workspaces: [SidebarWorkspace]) -> [SidebarWorkspace] { workspaces.filter { !$0.isMain } }
}

// MARK: Threads other people started

/// One row under a pond in the sidebar for a thread someone else started (DESIGN.md §8.10, "A shared pond is a pond"):
/// the same row a chat of mine has, plus the starter's small avatar. It opens as a normal workbench tab through
/// `PondThreadView`. Pure: the sidebar draws what this says.
public struct SharedThreadRow: Equatable, Sendable, Identifiable {
    public var pondId: String
    public var threadId: String
    public var title: String
    public var agent: String?
    public var starterId: String
    public var starterName: String
    public var state: PondThreadState
    public var lastActivityAt: Date?
    public var avatar: AvatarSpec
    /// "approval" or "question" while the thread waits on a person; nil otherwise and from an older host.
    public var waitingOn: String?
    public var id: String { "\(pondId)/\(threadId)" }

    /// The mark a chat of mine would show for this state: working, a question to answer, failed; nothing for a finished
    /// thread (its age shows). An approval waits on the starter, not on me, so it adds no "needs you" mark here.
    public var mark: ChatMark? {
        switch state {
        case .working: ChatMark(.working)
        case .needsYou: waitingOn == "approval" ? nil : ChatMark(.waiting, waiting: .answer)
        case .failed: ChatMark(.failed)
        case .finished: nil
        }
    }

    /// What the tooltip adds to the title and ownership line when the thread waits on its starter.
    public var stateWords: String? {
        guard state == .needsYou, waitingOn == "approval" else { return nil }
        let n = starterName.trimmingCharacters(in: .whitespaces)
        return "Waiting for \(n.isEmpty ? "the starter" : n) to approve"
    }

    /// The tooltip: the thread's title, then whose it is and where it runs, then what it waits on.
    public var help: String {
        [ThreadOwnership.tabHelp(title: title, starterName: starterName, isMine: false), stateWords].compactMap { $0 }.joined(separator: "\n")
    }
}

public enum SharedThreadRows {
    /// A thread no one is working on or waiting for stays in the sidebar this long, like every chat (`DEFAULT_RECENTLY_FINISHED_MS`).
    public static let recentWindow: TimeInterval = 24 * 3600

    /// The threads in a pond that someone else started, newest first by last activity (ties by title), as the rest of the
    /// sidebar orders them. Left out: my own threads (they are chats on this Mac and already have rows), a private thread
    /// (only its starter sees it, and the host never sends it, but a row for one is never drawn), and a finished one past a
    /// day, unless it is the one open (`keeping`). Without knowing who I am nothing is listed, so no thread of mine repeats.
    public static func rows(_ detail: PondDetail, now: Date = Date(), keeping: String? = nil) -> [SharedThreadRow] {
        guard detail.pond.state == .active, let me = detail.meMember?.id ?? detail.me?.id, !me.isEmpty else { return [] }
        let found: [SharedThreadRow] = detail.threads.compactMap { t in
            guard t.starter != me, !t.isPrivate else { return nil }
            let state = PondThreadState(raw: t.state)
            let live = state == .working || state == .needsYou
            let at = t.updatedAt
            let recent = at.map { now.timeIntervalSince($0) < recentWindow } ?? false
            guard live || recent || t.id == keeping else { return nil }
            let starterName = t.starterName.isEmpty ? (detail.members.first { $0.id == t.starter }?.name ?? "") : t.starterName
            return SharedThreadRow(
                pondId: detail.pond.id, threadId: t.id, title: t.title.isEmpty ? "Untitled thread" : t.title, agent: t.agent,
                starterId: t.starter, starterName: starterName, state: state, lastActivityAt: at,
                avatar: PondAvatars.spec(memberId: t.starter, name: starterName), waitingOn: t.waitingOn)
        }
        return found.sorted { a, b in
            switch (a.lastActivityAt, b.lastActivityAt) {
            case let (x?, y?) where x != y: return x > y
            case (nil, .some): return false
            case (.some, nil): return true
            default:
                let (x, y) = (a.title.lowercased(), b.title.lowercased())
                return x != y ? x < y : a.threadId < b.threadId
            }
        }
    }

    /// What a folded pond adds to its mark: waiting beats working beats nothing (a finished thread adds none).
    public static func foldedState(_ rows: [SharedThreadRow]) -> PondThreadState? {
        if rows.contains(where: { $0.state == .needsYou }) { return .needsYou }
        if rows.contains(where: { $0.state == .working }) { return .working }
        return nil
    }
}
