import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the centre: a 44pt header (project / workspace, branch chip, inspector toggle), a 36pt strip
// of the workspace's chats as tabs, then the chat itself (`SessionDetail`, restyled in a later step).

struct WorkbenchCentre: View {
    @Environment(AppModel.self) private var model
    let sidebarHidden: Bool
    @Binding var inspectorOpen: Bool
    let toggleSidebar: () -> Void
    let showingCompose: Bool
    /// DESIGN.md §8.10: the terminal panel (⌘J), at the bottom of this column; its height is remembered.
    @AppStorage("terminalOpen") private var terminalOpen = false
    @AppStorage("terminalPanelHeight") private var terminalHeight = TerminalPanelSizing.defaultHeight
    @State private var columnHeight: Double = 800

    var body: some View {
        let chat = (showingCompose || model.navFilter == .usage) ? nil : model.selectedSession
        // The workspace's open files (Files tab), which sit in the tab strip beside its chats.
        let files = chat?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        VStack(spacing: 0) {
            if let chat {
                let place = model.sidebarTree.place(of: chat.key)
                WorkbenchHeader(
                    session: chat, project: place?.project.name ?? HomeProjects.projectName(chat), workspace: place?.workspace.name,
                    sidebarHidden: sidebarHidden, inspectorOpen: $inspectorOpen, toggleSidebar: toggleSidebar)
                if let workspace = place?.workspace { WorkbenchTabs(workspace: workspace, files: files) }
            } else {
                HStack {
                    if sidebarHidden { SidebarToggleButton(action: toggleSidebar).padding(.leading, 78) }
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.header).background(WindowDragArea())
            }
            if showingCompose {
                DesktopComposePage()
            } else if let files, let file = files.activeFile {
                FileViewer(files: files, file: file).id(file.path)
            } else {
                DetailView()
            }
            if let chat, terminalOpen, !showingCompose {
                TerminalPanel(session: chat, column: columnHeight, height: $terminalHeight, open: $terminalOpen)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(GeometryReader { geo in
            Color.clear.onAppear { columnHeight = geo.size.height }.onChange(of: geo.size.height) { _, h in columnHeight = h }
        })
        .onChange(of: terminalOpen) { _, isOpen in if isOpen { TerminalHost.shared.focusPending = true } }
        // Another chat, workspace or the sidebar's pick brings the chat back over an open file.
        .onChange(of: model.selected) { for f in model.filesModels.values { f.activePath = nil } }
        .modifier(FileCloseGuard(files: files))
    }
}

struct SidebarToggleButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "sidebar.left").font(.system(size: 15)).foregroundStyle(Theme.muted)
                .frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show sidebar")
        .help("Show sidebar (⌘B)")
    }
}

private struct WorkbenchHeader: View {
    let session: HostSession
    let project: String
    let workspace: String?
    let sidebarHidden: Bool
    @Binding var inspectorOpen: Bool
    let toggleSidebar: () -> Void
    @Environment(AppModel.self) private var model
    @AppStorage("terminalOpen") private var terminalOpen = false

    var body: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { SidebarToggleButton(action: toggleSidebar).padding(.leading, 62) }
            HStack(spacing: 6) {
                Text(verbatim: project).foregroundStyle(Theme.muted)
                if let workspace {
                    Text("/").foregroundStyle(Theme.subtle)
                    Text(verbatim: workspace).foregroundStyle(Theme.ink)
                }
            }
            .font(Typo.label).lineLimit(1)
            if session.source == .squeak {
                GitCluster(session: session)
            } else if let branch = session.branch, !branch.isEmpty {
                HStack(spacing: 4) {
                    Lucide(.gitBranch, size: 11, color: Theme.muted)
                    Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
                .padding(.horizontal, 7).frame(height: 22)
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            }
            HeaderDiffstat(sessionKey: session.key.hostSessionId, activityStamp: model.activity.count)
            Spacer(minLength: 0)
            ChatRulesButton(session: session)
            OpenInMenu(session: session)
            Button { terminalOpen.toggle() } label: {
                Lucide(.squareTerminal, size: 15, color: terminalOpen ? Theme.ink : Theme.muted)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(terminalOpen ? "Hide terminal" : "Show terminal")
            .help(terminalOpen ? "Hide terminal (⌘J)" : "Show terminal (⌘J)")
            Button { inspectorOpen.toggle() } label: {
                Image(systemName: "sidebar.right").font(.system(size: 15)).foregroundStyle(inspectorOpen ? Theme.ink : Theme.muted)
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(inspectorOpen ? "Hide inspector" : "Show inspector")
            .help(inspectorOpen ? "Hide inspector (⌘⌥B)" : "Show inspector (⌘⌥B)")
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }
}

/// "Open in ▾" (quiet): Open in Conductor for a Conductor chat, and the workspace actions Conductor chats have.
private struct OpenInMenu: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    private var canOpen: Bool { session.capabilities.openInHost.isSupported }
    private var hasActions: Bool { session.conductorSessionId != nil && model.workspaceRepos != nil }
    private var resting: Bool { session.state != .working && !(session.state == .blocked && session.pendingQuestion == nil) }

    var body: some View {
        if canOpen || hasActions {
            Menu {
                if canOpen {
                    Button("Open in Conductor") { model.openInHost() }.disabled(model.openURL == nil && !model.demoMode)
                }
                if hasActions {
                    if canOpen { Divider() }
                    Button("Open a pull request") { Task { await model.askForPullRequest(session) } }.disabled(!resting)
                    Divider()
                    Button("Archive workspace…", role: .destructive) { Task { await model.archiveWorkspace(session) } }.disabled(!resting)
                }
            } label: {
                Text("Open in \(Image(systemName: "chevron.down"))").font(Typo.body).foregroundStyle(Theme.muted)
                .padding(.horizontal, 6).frame(height: 28).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .disabled(model.chatBusy)
            .help("Open this chat in Conductor, or workspace actions")
            .accessibilityLabel("Open in")
        }
    }
}

/// Workspace tabs hold their order across activity updates, workspace switches and relaunches.
private struct WorkbenchTabs: View {
    let workspace: SidebarWorkspace
    let files: FilesModel?
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var chats: [HostSession] {
        let keys = model.workspaceTabOrder.ordered(workspace: workspace.id, available: workspace.chats.map { $0.key.stringValue })
        let byKey = Dictionary(workspace.chats.map { ($0.key.stringValue, $0) }, uniquingKeysWith: { first, _ in first })
        // Tabs the person closed stay off the strip (⇧⌘T brings the last back), unless one is the chat on screen.
        let closed = WorkbenchPrefs.shared.closed
        return keys.compactMap { byKey[$0] }.filter { !closed.isClosed($0.key.stringValue, in: workspace.id) || $0.key == model.selected }
    }

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(chats) { s in tab(s) }
                    if let files, !files.open.isEmpty {
                        Rectangle().fill(Theme.line).frame(width: 1, height: 16).padding(.horizontal, 2)
                        ForEach(files.open) { f in FileTab(files: files, file: f) }
                    }
                }
                .padding(.horizontal, Space.m)
            }
            Button {
                if let native = model.nativeWorkspace(of: workspace) {
                    NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: native.projectId, workspaceId: native.id))
                } else {
                    let conductorWorkspace = workspace.chats.first?.conductorWorkspaceId
                    if conductorWorkspace != nil { NewChatController.shared.state.useConductor = true }
                    NewChatController.shared.show(preselect: conductorWorkspace)
                }
            } label: {
                Lucide(.plus, size: Metrics.iconSmall, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.trailing, Space.m)
            .accessibilityLabel("New chat").help("New chat (⌘N)")
        }
        .frame(height: Metrics.tabStrip)
        .onChange(of: workspace.chats.map(\.key), initial: true) { _, _ in model.synchronizeChatTabs(workspace) }
        .onChange(of: workspace.id) { _, _ in model.synchronizeChatTabs(workspace) }
        // A chat opened some other way (the sidebar, a notification) is no longer closed.
        .onChange(of: model.selected) { _, key in if let key { WorkbenchPrefs.shared.forgetClosed(key, in: workspace.id) } }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: chats.map(\.key))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    /// Hides the tab (the chat is untouched); closing the open one moves to the tab beside it.
    private func closeTab(_ s: HostSession) {
        let shown = chats
        guard shown.count > 1 else { return }
        if s.key == model.selected, let next = shown.first(where: { $0.key != s.key }) { model.select(next.key) }
        WorkbenchPrefs.shared.closeTab(s.key, in: workspace.id)
    }

    private func reopenTab() {
        if let key = WorkbenchPrefs.shared.reopenTab(in: workspace.id, available: workspace.chats.map(\.key)) { model.select(key) }
    }

    /// Running gets a trailing matrix; completed unread is semibold.
    /// The Conductor source marker remains, but status dots and spinners do not accompany titles.
    private func tab(_ s: HostSession) -> some View {
        let selected = model.selected == s.key && files?.activePath == nil
        let running = s.state == .working
        let mark = selected || running ? nil : model.mark(for: s)
        return Button { files?.activePath = nil; model.select(s.key) } label: {
            HStack(spacing: 6) {
                Text(verbatim: model.workbenchTitle(s)).font(model.isUnread(s) ? Typo.label : Typo.body)
                    .foregroundStyle(selected || model.isUnread(s) ? Theme.ink : Theme.muted).lineLimit(1)
                if s.showsConductorBadge { ConductorMarker().fixedSize() }
                if running { ChatTabActivity() }
            }
            .padding(.leading, 10).padding(.trailing, 6).frame(height: 28).frame(maxWidth: 320)
            .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .draggable(s.key.stringValue)
        .dropDestination(for: String.self) { values, _ in
            guard values.count == 1, let source = values.first else { return false }
            return model.moveChatTab(source, before: s.key, workspace: workspace)
        }
        .accessibilityLabel(SessionText.accessibility(title: model.workbenchTitle(s), mark: mark, last: s.lastActivityAt)
                            + (running ? ", Running" : ""))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help("Drag to reorder this chat tab")
        .contextMenu {
            Button("Close tab") { closeTab(s) }.disabled(chats.count < 2)
            Button("Reopen closed tab") { reopenTab() }.disabled(!WorkbenchPrefs.shared.closed.hasClosed(in: workspace.id))
        }
    }
}
