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
                    // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                    if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding + PaneToggle.size) }
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.header).background(WindowDragArea())
            }
            if showingCompose {
                DesktopComposePage()
            } else if let files, let chat, let diff = files.diffs.active {
                DiffTabView(files: files, target: diff, session: chat).id(diff)
            } else if let files, let file = files.activeFile {
                FileViewer(files: files, file: file).id(file.path)
            } else {
                DetailView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Another chat, workspace or the sidebar's pick brings the chat back over an open file.
        .onChange(of: model.selected) { for f in model.filesModels.values { f.showChat() } }
        .modifier(FileCloseGuard(files: files))
        .onReceive(NotificationCenter.default.publisher(for: .squeakShowAllChanges)) { _ in files?.showDiff(.all) }
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
    @State private var icon: NSImage?

    private var branch: String? { session.branch.flatMap { $0.isEmpty ? nil : $0 } }

    var body: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding + PaneToggle.size - Space.l) }
            repoIcon
            HStack(spacing: 8) {
                Text(verbatim: project).foregroundStyle(Theme.ink)
                if let crumb = branch ?? workspace {
                    Lucide(.chevronRight, size: 12, color: Theme.subtle)
                    Text(verbatim: crumb).foregroundStyle(Theme.ink).truncationMode(.middle)
                }
            }
            .font(.system(size: 15, weight: .medium)).lineLimit(1)
            moreMenu
            HeaderDiffstat(sessionKey: session.key.hostSessionId, activityStamp: model.activity.count).hidden().frame(width: 0)
            Spacer(minLength: Space.m)
            targetBranch
            ChatRulesButton(session: session)
            OpenInMenu(session: session)
            // The git primary action sits above the panel while it is open (the panel's top row); otherwise here.
            if !inspectorOpen, session.source == .squeak { GitCluster(session: session, showsBranch: false) }
            // The inspector's toggle (PaneToggleOverlay) sits here while the panel is closed.
            if !inspectorOpen { Color.clear.frame(width: PaneToggle.size) }
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
        .task(id: project) {
            let icons = await Task.detached(priority: .utility) { RepositoryIcons.read() }.value
            icon = icons[project].flatMap { NSImage(data: $0) }
        }
    }

    @ViewBuilder private var repoIcon: some View {
        if let icon {
            Image(nsImage: icon).resizable().scaledToFit().frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 4))
        } else {
            Text(String(project.prefix(1)).uppercased()).font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 20, height: 20)
        }
    }

    /// ···: the branch and folder actions the palette has, and Open in Conductor where the chat has one.
    private var moreMenu: some View {
        Menu {
            Button("Copy branch name") {
                if let b = branch { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(b, forType: .string) }
            }.disabled(branch == nil)
            Button("Reveal folder in Finder") {
                if let p = session.cwd, FileManager.default.fileExists(atPath: p) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) }
            }.disabled(session.cwd == nil)
            if session.capabilities.openInHost.isSupported {
                Divider()
                Button("Open in Conductor") { model.openInHost() }.disabled(model.openURL == nil && !model.demoMode)
            }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 26, height: 26).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More").help("Copy the branch, reveal the folder")
    }

    /// The branch this one merges into, quietly, as the target's header shows it.
    @ViewBuilder private var targetBranch: some View {
        if session.source == .squeak, let base = model.gitStatus(session)?.base, !base.isEmpty {
            Text(verbatim: "origin/\(base)").font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 170, alignment: .trailing).help("The branch this merges into")
        }
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
                HStack(spacing: 4) {
                    Lucide(.externalLink, size: 14, color: Theme.muted)
                    Lucide(.chevronDown, size: 11, color: Theme.muted)
                }
                .padding(.horizontal, 8).frame(height: 28).contentShape(Rectangle())
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
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
                    if let files, !files.diffs.open.isEmpty {
                        Rectangle().fill(Theme.line).frame(width: 1, height: 16).padding(.horizontal, 2)
                        ForEach(files.diffs.open, id: \.self) { t in
                            DiffTabChip(files: files, target: t)
                        }
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
                        Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.leading, 4)
                    .accessibilityLabel("New chat").shortcutHint("New chat", .newTab)
                }
                .padding(.horizontal, Space.l)
            }
            Button { reopenTab() } label: {
                Lucide(.history, size: 16, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.trailing, Space.m)
            .disabled(!WorkbenchPrefs.shared.closed.hasClosed(in: workspace.id) && files?.diffs.hasClosed != true)
            .accessibilityLabel("Reopen closed tab").shortcutHint("Reopen closed tab", .reopenTab)
        }
        .frame(height: Metrics.tabStrip)
        .onChange(of: workspace.chats.map(\.key), initial: true) { _, _ in model.synchronizeChatTabs(workspace) }
        .onChange(of: workspace.id) { _, _ in model.synchronizeChatTabs(workspace) }
        .onReceive(NotificationCenter.default.publisher(for: .squeakCloseTab)) { _ in
            if let files, let diff = files.diffs.active { files.closeDiff(diff) }
            else if let files, let path = files.activePath { files.close(path) }
            else if let s = chats.first(where: { $0.key == model.selected }) { closeTab(s) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .squeakStepTab)) { note in
            let delta = (note.object as? Int) ?? 1
            let shown = chats
            let current = files?.activePath == nil && files?.diffs.active == nil ? model.selected : nil
            if let next = ChatTabs.step(from: current, in: shown.map(\.key), by: delta) { files?.showChat(); model.select(next) }
        }
        // A chat opened some other way (the sidebar, a notification) is no longer closed.
        .onChange(of: model.selected) { _, key in if let key { WorkbenchPrefs.shared.forgetClosed(key, in: workspace.id) } }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: chats.map(\.key))
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    /// Hides the tab (the chat is untouched); closing the open one moves to the tab beside it.
    private func closeTab(_ s: HostSession) {
        let shown = chats
        guard ChatTabs.canClose(shown: shown.count) else { return }
        if let next = ChatTabs.selectionAfterClosing(s.key, selected: model.selected, shown: shown.map(\.key)) { model.select(next) }
        WorkbenchPrefs.shared.closeTab(s.key, in: workspace.id)
    }

    private func reopenTab() {
        // A closed diff tab comes back before a closed chat tab (the latest thing closed is not tracked across both).
        if let files, files.diffs.hasClosed, !WorkbenchPrefs.shared.closed.hasClosed(in: workspace.id) { files.reopenDiff(); return }
        if let key = WorkbenchPrefs.shared.reopenTab(in: workspace.id, available: workspace.chats.map(\.key)) { model.select(key) }
    }

    /// A working chat's tab leads with Squeak's matrix glyph; any other tab has no mark (no grip: tabs still drag).
    /// Completed unread is semibold.
    /// The Conductor source marker remains, but status dots and spinners do not accompany titles.
    private func tab(_ s: HostSession) -> some View {
        let selected = model.selected == s.key && files?.activePath == nil && files?.diffs.active == nil
        let running = s.state == .working
        let mark = selected || running ? nil : model.mark(for: s)
        return Button { files?.showChat(); model.select(s.key) } label: {
            HStack(spacing: 7) {
                // Which agent runs the chat, in Squeak's own marks (§3.3), before the title.
                if let agent = AgentMark(agent: s.agent, size: 14) { agent.opacity(selected ? 1 : 0.8).help(SessionText.agentName(s.agent) ?? "") }
                if running { ChatTabActivity() }
                Text(verbatim: model.workbenchTitle(s)).font(.system(size: 14, weight: model.isUnread(s) ? .semibold : .regular))
                    .foregroundStyle(selected || model.isUnread(s) ? Theme.ink : Theme.muted).lineLimit(1)
                if s.showsConductorBadge { ConductorMarker().fixedSize() }
            }
            .padding(.horizontal, 12).frame(height: Metrics.tabStrip).frame(maxWidth: 320)
            .overlay(alignment: .bottom) { Rectangle().fill(selected ? Theme.ink : .clear).frame(height: 2) }
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
