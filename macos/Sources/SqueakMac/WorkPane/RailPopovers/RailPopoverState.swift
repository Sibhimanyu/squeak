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

/// Every Duck's changed files in a Pond, from the host (`GET /native/projects/<id>/changes`). Read when a list opens and now
/// and then while the window is up, so the Changes badge on the Dashboard and Room stays near the truth.
@MainActor @Observable
final class PondChangesModel {
    private(set) var changes: HostPondChanges?
    private(set) var loaded = false
    @ObservationIgnored private var lastRead: Date?

    func refresh(projectId: String, host: NativeHostClient, force: Bool = false) async {
        if !force, let lastRead, Date().timeIntervalSince(lastRead) < 10 { return }
        lastRead = Date()
        let read = try? await host.pondChanges(projectId: projectId)
        if read != changes { changes = read }
        loaded = true
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
