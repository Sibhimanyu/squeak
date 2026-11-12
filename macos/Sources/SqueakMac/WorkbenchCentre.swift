import AppKit
import SqueakIcons
import SqueakMacCore
import Heresay
import SwiftUI

// DESIGN.md §8.10, the centre: a 44pt header (project / workspace, branch chip, inspector toggle), a 36pt strip
// of the workspace's chats as tabs, then the chat itself (`SessionDetail`, restyled in a later step).

struct WorkbenchCentre: View {
    @Environment(AppModel.self) private var model
    let sidebarHidden: Bool
    @Binding var inspectorOpen: Bool
    let toggleSidebar: () -> Void
    let showingCompose: Bool

    /// A pond's home or a thread from it takes the centre while a pond route is open (Ponds/PondHome.swift).
    var body: some View {
        Group {
            if let route = PondsModel.shared.route, !showingCompose {
                PondRouteView(route: route, sidebarHidden: sidebarHidden).heresayPrivate()
            } else {
                workbench
            }
        }
        .onChange(of: model.selected) { PondsModel.shared.route = nil }
        .onChange(of: model.navFilter) { _, new in if new == .usage { PondsModel.shared.route = nil } }
    }

    @ViewBuilder private var workbench: some View {
        let chat = (showingCompose || model.navFilter == .usage) ? nil : model.selectedSession
        // The workspace's open files (Files tab), which sit in the tab strip beside its chats.
        let files = chat?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        VStack(spacing: 0) {
            if let chat {
                let place = model.sidebarTree.place(of: chat.key)
                WorkbenchHeader(
                    session: chat, project: place?.project.name ?? HomeProjects.projectName(chat), workspace: place?.workspace.displayTitle,
                    sidebarHidden: sidebarHidden, inspectorOpen: $inspectorOpen, toggleSidebar: toggleSidebar)
                if let workspace = place?.workspace { WorkbenchTabs(workspace: workspace, files: files) }
            } else {
                HStack {
                    // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                    if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve) }
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.header).background(WindowDragArea())
            }
            if showingCompose {
                DesktopComposePage()
            } else if let files, let chat, let diff = files.diffs.active {
                DiffTabView(files: files, target: diff, session: chat).id(diff).heresayPrivate()
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

/// One breadcrumb part: a plain button with a hover wash and the pointing hand.
private struct CrumbButton: View {
    let title: String
    let label: String
    var truncate = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Text(verbatim: title).foregroundStyle(Theme.ink)
                .truncationMode(truncate ? .middle : .tail)
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(hovering ? Theme.ink.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { inside in
            hovering = inside
            if inside { NSCursor.pointingHand.push() } else { NSCursor.pop() }
        }
        .onDisappear { if hovering { hovering = false; NSCursor.pop() } }
        .accessibilityLabel(label)
        .help(label)
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

    /// A Squeak stream reads by its title; any other chat by its branch, else its workspace.
    private var streamTitle: String? { session.workspaceTitle.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : workspace } }
    private var branch: String? { session.branch.flatMap { $0.isEmpty ? nil : $0 } }

    var body: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve - Space.l) }
            repoIcon
            HStack(spacing: 8) {
                CrumbButton(title: project, label: PondWords.breadcrumb(project)) {
                    WorkbenchNav.openProject(model, name: project)
                }
                if let crumb = streamTitle ?? branch ?? workspace {
                    Lucide(.chevronRight, size: 12, color: Theme.subtle)
                    CrumbButton(title: crumb, label: "Show \(crumb)'s chats", truncate: true) {
                        if let place = model.sidebarTree.place(of: session.key) {
                            WorkbenchNav.showDashboard(model, filter: .workspace(id: place.workspace.id, name: crumb))
                        } else {
                            WorkbenchNav.showDashboard(model, filter: .project(project))
                        }
                    }
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
    }

    @ViewBuilder private var repoIcon: some View {
        if let icon = PondIcons.shared.icon(named: project) {
            Image(nsImage: icon).resizable().scaledToFit().frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 20 * 0.28, style: .continuous))
        } else {
            Text(String(project.prefix(1)).uppercased()).font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 20, height: 20)
        }
    }

    /// ···: the branch and folder actions the palette has, and Open in Conductor where the chat has one.
    private var moreMenu: some View {
        SqueakMenu {
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
            SqueakMenu {
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
    @State private var showHistory = false

    private var chats: [HostSession] {
        let keys = model.workspaceTabOrder.ordered(workspace: workspace.id, available: workspace.chats.map { $0.key.stringValue })
        let byKey = Dictionary(workspace.chats.map { ($0.key.stringValue, $0) }, uniquingKeysWith: { first, _ in first })
        // Tabs the person closed stay off the strip (⇧⌘T brings the last back), unless one is the chat on screen.
        let closed = WorkbenchPrefs.shared.closed
        return keys.compactMap { byKey[$0] }.filter { !closed.isClosed($0.key.stringValue, in: workspace.id) || $0.key == model.selected }
    }

    @State private var stripWidth: Double = 0
    @State private var hoveredTab: SessionKey?
    private var tabWidth: Double { ChatTabWidth.width(count: chats.count, available: stripWidth - 120) }

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
                            model.openNewThread(projectId: native.projectId, workspaceId: native.id)
                        } else if let conductorWorkspace = workspace.chats.first?.conductorWorkspaceId {
                            model.openNewThread(conductorWorkspaceId: conductorWorkspace)
                        } else {
                            model.openNewThread()
                        }
                    } label: {
                        Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.leading, 4)
                    .accessibilityLabel("New thread").shortcutHint("New thread", .newTab)
                }
                .padding(.horizontal, Space.l)
            }
            Button { showHistory.toggle() } label: {
                Lucide(.history, size: 16, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.trailing, Space.m)
            .popover(isPresented: $showHistory, arrowEdge: .bottom) {
                ChatHistoryPopover(workspace: workspace) { showHistory = false }
            }
            .accessibilityLabel("Chat history").help("Chat history")
        }
        .frame(height: Metrics.tabStrip)
        .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { stripWidth = $0 }
        .onChange(of: workspace.chats.map(\.key), initial: true) { _, _ in model.synchronizeChatTabs(workspace) }
        .onChange(of: workspace.id) { _, _ in model.synchronizeChatTabs(workspace) }
        .onReceive(NotificationCenter.default.publisher(for: .squeakCloseTab)) { note in
            let box = note.object as? CloseTabAction.Box
            if let files, let diff = files.diffs.active { files.closeDiff(diff); box?.handled = true }
            else if let files, let path = files.activePath { files.close(path); box?.handled = true }
            else if let s = chats.first(where: { $0.key == model.selected }), ChatTabs.canClose(shown: chats.count) { closeTab(s); box?.handled = true }
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
    /// Just the agent's own logo (Claude's, Codex's), no badge; the duck only for an agent with no logo.
    @ViewBuilder private func tabIcon(_ s: HostSession) -> some View {
        if let m = s.agentMark, m != .conductor { AgentMark(m, size: 16) }
        else { ThreadDuckView(id: s.key.stringValue, agent: s.agent, size: ThreadDuck.Size.tab) }
    }

    /// The Conductor source marker remains, but status dots and spinners do not accompany titles.
    private func tab(_ s: HostSession) -> some View {
        let selected = model.selected == s.key && files?.activePath == nil && files?.diffs.active == nil
        let running = s.state == .working
        let mark = selected || running ? nil : model.mark(for: s)
        return Button { files?.showChat(); model.select(s.key) } label: {
            HStack(spacing: 7) {
                // Which agent runs the chat, in Squeak's own marks (§3.3), before the title.
                tabIcon(s).opacity(selected ? 1 : 0.8).tabWorkingPulse(running).help(SessionText.agentName(s.agent) ?? "")
                Text(verbatim: model.workbenchTitle(s)).font(.system(size: 14, weight: model.isUnread(s) ? .semibold : .regular))
                    .foregroundStyle(selected || model.isUnread(s) ? Theme.ink : Theme.muted).lineLimit(1).truncationMode(.tail)
                    .frame(maxWidth: ChatTabWidth.maxTitle, alignment: .leading)
                if s.showsConductorBadge { ConductorMarker().fixedSize() }
                Spacer(minLength: 0)
            }
            .padding(.leading, 12).padding(.trailing, 28).frame(width: tabWidth, height: Metrics.tabStrip, alignment: .leading)
            .overlay(alignment: .trailing) {
                if chats.count > 1 {
                    Button { closeTab(s) } label: {
                        Lucide(.x, size: 12, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.trailing, 6)
                    .opacity(hoveredTab == s.key ? 1 : 0).allowsHitTesting(hoveredTab == s.key)
                    .accessibilityLabel("Close \(model.workbenchTitle(s))")
                }
            }
            .onHover { hoveredTab = $0 ? s.key : (hoveredTab == s.key ? nil : hoveredTab) }
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
        .help(model.workbenchTitle(s))
        .squeakContextMenu {
            Button("Close tab") { closeTab(s) }.disabled(chats.count < 2)
            Button("Reopen closed tab") { reopenTab() }.disabled(!WorkbenchPrefs.shared.closed.hasClosed(in: workspace.id))
        }
    }
}


private extension View {
    /// A working chat's tab pulses its agent logo, no extra width.
    @ViewBuilder func tabWorkingPulse(_ on: Bool) -> some View {
        if on { phaseAnimator([1.0, 0.45]) { $0.opacity($1) } animation: { _ in .easeInOut(duration: 0.9) } } else { self }
    }
}
