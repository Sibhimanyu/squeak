import Foundation
import SqueakIcons
import Observation
import SqueakMacCore
import SwiftUI

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

// MARK: Navigation actions and the window's hidden shortcut buttons

@MainActor
enum WorkbenchNav {
    static func goHome(_ model: AppModel) {
        NewChatController.shared.hide()
        model.closeSettings()
        model.select(nil)
        model.navFilter = .home
    }

    static func stepWorkspace(_ model: AppModel, by delta: Int) {
        let tree = model.sidebarTree
        guard let ws = WorkspaceNavigation.step(from: model.selected, by: delta, in: tree, pins: WorkbenchPrefs.shared.pins.ids),
              let chat = ws.chats.first else { return }
        model.select(chat.key)
    }

    static func attention(_ model: AppModel) -> AttentionJump? {
        AttentionJump.make(after: model.selected, in: model.sidebarTree, pins: WorkbenchPrefs.shared.pins.ids, mark: { model.mark(for: $0) })
    }

    static func reopenTab(_ model: AppModel) {
        guard let selected = model.selected, let place = model.sidebarTree.place(of: selected),
              let key = WorkbenchPrefs.shared.reopenTab(in: place.workspace.id, available: place.workspace.chats.map(\.key)) else { return }
        model.select(key)
    }
}

/// ⇧⌘H Home, ⌥⌘↑/↓ workspaces, ⌥⌘L next chat that needs you, ⇧⌘T reopen tab, ⌃O every step, ⌘L the message field.
/// Lives in the window's hidden button stack, so each works wherever focus is.
struct WorkbenchShortcuts: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Button("Home") { WorkbenchNav.goHome(model) }.keyboardShortcut("h", modifiers: [.command, .shift])
        Button("Previous workspace") { WorkbenchNav.stepWorkspace(model, by: -1) }.keyboardShortcut(.upArrow, modifiers: [.command, .option])
        Button("Next workspace") { WorkbenchNav.stepWorkspace(model, by: 1) }.keyboardShortcut(.downArrow, modifiers: [.command, .option])
        Button("Next chat that needs you") { if let j = WorkbenchNav.attention(model) { model.select(j.key) } }
            .keyboardShortcut("l", modifiers: [.command, .option])
        Button("Reopen closed tab") { WorkbenchNav.reopenTab(model) }.keyboardShortcut("t", modifiers: [.command, .shift])
        Button("Expand or fold every step") { WorkbenchPrefs.shared.toggleExpandAll() }.keyboardShortcut("o", modifiers: .control)
        Button("Focus the message field") { NotificationCenter.default.post(name: .squeakFocusComposer, object: nil) }
            .keyboardShortcut("l", modifiers: .command)
    }
}

/// "Next unread ›" (§8.10): a floating pill at the transcript's bottom right while another chat needs you; one press
/// opens it. It takes no room, so nothing moves when it shows.
struct NextAttentionPill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let jump = WorkbenchNav.attention(model) {
            Button { model.select(jump.key) } label: {
                HStack(spacing: 6) {
                    Text(verbatim: jump.label).font(Typo.body).foregroundStyle(Theme.ink)
                    Lucide(.chevronRight, size: 12, color: Theme.muted)
                }
                .padding(.horizontal, 12).frame(height: 30)
                .background(Theme.surfaceRaised, in: Capsule())
                .overlay(Capsule().strokeBorder(Theme.lineStrong))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .help("Go to the next chat that needs you (⌥⌘L)")
            .accessibilityLabel(jump.label)
            .transition(.opacity)
        }
    }
}
