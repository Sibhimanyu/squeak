import AppKit
import Heresay
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The dockable panels as views that fill whatever zone they are put in: the Thread, the Pond, the Code tools (Files,
// Changes, Review) and the Terminal. None of them knows where it sits; the zone draws the tab and the frame.

/// The panel a zone shows, for the chat `session`.
struct DockPanelContent: View {
    let panel: DockPanel
    let session: HostSession?

    var body: some View {
        switch panel {
        case .thread: ThreadPanel(session: session)
        case .pond: PondPanel(session: session)
        case .code: CodePanelView(session: session)
        case .terminal: TerminalPanelView(session: session)
        }
    }
}

struct TerminalPanelView: View {
    let session: HostSession?
    var shell: UUID?
    /// A folder to run in when there is no chat (beside a pond page).
    var cwd: String?

    var body: some View {
        if let session {
            TerminalPanel(session: session, shell: shell)
        } else if let cwd {
            TerminalPanel(cwd: cwd, shell: shell)
        } else {
            Text("Open a chat to use its terminal.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// Files, Changes and Review under their own small tab row (the sub-tab is remembered in `inspectorTab`).
struct CodePanelView: View {
    let session: HostSession?
    /// A tab that is its own strip tab (beside a pond page): the sub-tab row is not the person's to change.
    var fixedTab: InspectorTab?
    @Environment(AppModel.self) private var model
    @AppStorage(InspectorTabMemory.defaultsKey) private var memoryRaw = ""
    @AppStorage(InspectorTabMemory.fallbackKey) private var globalTabRaw = InspectorTab.changes.rawValue
    /// The sub-tab this workspace last used (the global default for one that never chose).
    private var tabRaw: String { InspectorTabMemory.resolve(memoryRaw, workspace: model.focus.workspace, fallback: globalTabRaw) }
    @AppStorage("changesAsTree") private var asTree = false
    @State private var searching = false
    @State private var query = ""

    private var native: Bool { session?.source == .squeak }
    private var tab: InspectorTab { fixedTab ?? InspectorTab.restored(tabRaw) }

    var body: some View {
        VStack(spacing: 0) {
            if fixedTab == nil { tabRow }
            if searching && tab == .changes { searchField }
            Rectangle().fill(Theme.line).frame(height: 1)
            upper.frame(maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onChange(of: tabRaw) { _, _ in if tab != .changes { searching = false; query = "" } }
    }

    private var changeCount: Int? {
        guard let session, let c = model.changesStore(for: session.key.hostSessionId).changes, !c.files.isEmpty else { return nil }
        return c.files.count
    }

    private var tabRow: some View {
        HStack(spacing: 2) {
            ForEach(InspectorTab.available(native: native)) { t in
                Button { InspectorTabMemory.write(t.rawValue, workspace: model.focus.workspace) } label: {
                    HStack(spacing: 5) {
                        Text(t.title).font(.system(size: 14, weight: tab == t ? .medium : .regular))
                            .foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                        if t == .changes, let n = changeCount {
                            Text("\(n)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
                        }
                    }
                    .padding(.horizontal, 10).frame(height: 30)
                    .background(tab == t ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == t ? .isSelected : [])
            }
            Spacer(minLength: 0)
            if tab == .changes {
                iconButton(.search, searching ? "Close search" : "Search changed files", on: searching) { searching.toggle(); if !searching { query = "" } }
                iconButton(asTree ? .list : .folderTree, asTree ? "Show as a list" : "Show as a tree") { asTree.toggle() }
            }
            moreMenu
        }
        .padding(.horizontal, Space.s).frame(height: 40)
    }

    private func iconButton(_ name: LucideName, _ help: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: 15, color: on ? Theme.ink : Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }

    private var moreMenu: some View {
        SqueakMenu {
            Button("Refresh changes") {
                if let session { Task { await model.changesStore(for: session.key.hostSessionId).refresh(sessionKey: session.key.hostSessionId, visible: true, activityChanged: true) } }
            }
            Button("Copy changed file paths") {
                if let session, let files = model.changesStore(for: session.key.hostSessionId).changes?.files {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(files.map(\.path).joined(separator: "\n"), forType: .string)
                }
            }
            .disabled(changeCount == nil)
            Divider()
            Button(DockStore.shared.isTerminalShowing ? "Hide terminal (⌘J)" : "Show terminal (⌘J)") {
                TerminalActions.toggle(model)
            }
        } label: {
            Lucide(.ellipsisVertical, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More")
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Lucide(.search, size: 13, color: Theme.muted)
            TextField("Filter changed files", text: $query).textFieldStyle(.plain).font(.system(size: 13))
            if !query.isEmpty {
                Button { query = "" } label: { Lucide(.x, size: 11, color: Theme.muted) }.buttonStyle(.plain).accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 10).frame(height: 30)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.horizontal, Space.m).padding(.bottom, 8)
    }

    @ViewBuilder private var upper: some View {
        switch tab {
        case .review: changesOrEmpty { ReviewTab(session: $0) }
        case .changes: changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count, query: query, asTree: asTree).heresayPrivate() }
        case .files: changesOrEmpty { FilesTab(session: $0).heresayPrivate() }
        }
    }

    @ViewBuilder private func changesOrEmpty<V: View>(@ViewBuilder _ content: (HostSession) -> V) -> some View {
        if let session {
            content(session)
        } else {
            Text("Open a chat to see what it changed.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }
}
