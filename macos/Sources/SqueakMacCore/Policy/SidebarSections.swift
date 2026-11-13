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
