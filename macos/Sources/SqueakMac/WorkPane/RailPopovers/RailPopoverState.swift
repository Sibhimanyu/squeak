import Foundation
import Observation
import SqueakMacCore

// DESIGN.md 8.12: which rail popover is open. One at a time, never saved, never pinned: it closes when an item is picked,
// when the person clicks away or presses Esc, and when the page changes.

@MainActor @Observable
final class RailPopoverState {
    static let shared = RailPopoverState()
    private(set) var open: RailTool?
    /// Set by a Duck's Stream chip: the Changes list shows that Stream only. Cleared whenever the list closes, so the rail's own
    /// Changes button always opens the whole list.
    var changesFilter: RailChangeFilter?

    func toggle(_ tool: RailTool) { changesFilter = nil; open = open == tool ? nil : tool }
    func close() { changesFilter = nil; open = nil }

    func isOpen(_ tool: RailTool) -> Bool { open == tool }
    func set(_ tool: RailTool, open on: Bool) {
        if on { open = tool } else if open == tool { open = nil; changesFilter = nil }
    }

    /// A chip was clicked: opens Changes narrowed to its Stream (or the Pond's own folder).
    func showChanges(_ filter: RailChangeFilter) { changesFilter = filter; open = .changes }
}

/// Every Duck's changed files in a Pond, from the host (`GET /native/projects/<id>/changes`). Kept warm by the rail from the
/// moment a Pond page shows (`RailWarmer`), so the Changes list opens from what is already here; a list that opens reads
/// again quietly and the rows change in place. The rows are built off the main thread when the answer arrives.
@MainActor @Observable
final class PondChangesModel {
    private(set) var changes: HostPondChanges?
    /// The list's rows, built once per host answer (no chats filled in; `RailChanges.keyed` does that when drawing).
    private(set) var sections: [RailChangeSection] = []
    private(set) var loaded = false
    @ObservationIgnored private var lastRead: Date?
    @ObservationIgnored private var running: Task<Void, Never>?

    func refresh(projectId: String, host: NativeHostClient, force: Bool = false, cached: Bool = false) async {
        if !force, let lastRead, Date().timeIntervalSince(lastRead) < 10 { return }
        // One read at a time: a second ask waits for the one in flight instead of starting another on the host.
        if let running { await running.value; return }
        lastRead = Date()
        let task = Task { [weak self] in
            let read = try? await host.pondChanges(projectId: projectId, cached: cached)
            guard let self else { return }
            if read != self.changes {
                let built = await Task.detached(priority: .userInitiated) {
                    read.map { RailChanges.pondSections($0, sessions: [], mainSessionKey: nil) } ?? []
                }.value
                self.changes = read
                self.sections = built
            }
            self.loaded = true
        }
        running = task
        await task.value
        running = nil
    }
}

@MainActor @Observable
final class PondChangesStore {
    static let shared = PondChangesStore()
    @ObservationIgnored private var models: [String: PondChangesModel] = [:]
    func model(for projectId: String) -> PondChangesModel {
        if let m = models[projectId] { return m }
        let m = PondChangesModel()
        models[projectId] = m
        return m
    }
}

/// Files Ducks opened or showed in each Pond (newest first), for the Files list's Recent. Held for the session; a restored
/// tab still shows through `RailRecentFiles.list(openTabs:)`.
@MainActor @Observable
final class RailRecentStore {
    static let shared = RailRecentStore()
    private var byPond: [String: RailRecentFiles] = [:]

    func note(_ item: TabItem, in projectId: String) {
        guard item.kind == .file else { return }
        byPond[projectId, default: RailRecentFiles()].note(item.id)
    }

    func ids(in projectId: String, openTabs: [TabItem]) -> [String] {
        byPond[projectId, default: RailRecentFiles()].list(openTabs: openTabs.filter { $0.kind == .file }.map(\.id))
    }
}
