import Foundation
import Observation
import SqueakMacCore

/// The person's own marks on the workbench, kept on this Mac: pinned workspaces, tabs they closed, whether every
/// step in the transcript is open. One place, so the sidebar, the tab strip and the shortcuts agree.
@MainActor @Observable
final class WorkbenchPrefs {
    static let shared = WorkbenchPrefs()

    private(set) var pins: WorkspacePins
    private(set) var closed: ClosedTabs
    /// ⌃O: every tool row, thinking block and fold open or folded; `generation` makes a repeat press reach rows that
    /// were opened or closed by hand since.
    private(set) var allOpen = false
    private(set) var generation = 0
    @ObservationIgnored private let defaults = UserDefaults.standard

    private init() {
        pins = defaults.data(forKey: "workspacePins").flatMap { try? JSONDecoder().decode(WorkspacePins.self, from: $0) } ?? WorkspacePins()
        closed = defaults.data(forKey: "closedChatTabs").flatMap { try? JSONDecoder().decode(ClosedTabs.self, from: $0) } ?? ClosedTabs()
    }

    func togglePin(_ workspaceId: String) {
        pins.toggle(workspaceId)
        defaults.set(try? JSONEncoder().encode(pins), forKey: "workspacePins")
    }

    func closeTab(_ chat: SessionKey, in workspace: String) {
        closed.close(chat.stringValue, in: workspace)
        saveClosed()
    }

    func reopenTab(in workspace: String, available: [SessionKey]) -> SessionKey? {
        let keys = Dictionary(available.map { ($0.stringValue, $0) }, uniquingKeysWith: { a, _ in a })
        let hit = closed.reopen(in: workspace, available: Set(keys.keys))
        saveClosed()
        return hit.flatMap { keys[$0] }
    }

    func forgetClosed(_ chat: SessionKey, in workspace: String) {
        guard closed.isClosed(chat.stringValue, in: workspace) else { return }
        closed.forget(chat.stringValue, in: workspace)
        saveClosed()
    }

    func toggleExpandAll() { allOpen.toggle(); generation += 1 }

    private func saveClosed() { defaults.set(try? JSONEncoder().encode(closed), forKey: "closedChatTabs") }
}

extension Notification.Name {
    /// ⌘L: put the cursor in the open chat's message field.
    static let squeakFocusComposer = Notification.Name("SqueakFocusComposer")
}
