import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// Project navigation only: brand and project actions above a two-level project/worktree tree.
// Chats belong to the workspace tab strip, never this sidebar.
// Every list is newest first and the tree is `SidebarTreeBuilder`'s (SqueakMacCore): this file only draws.

struct WorkbenchSidebar: View {
    /// The pane's drawn width (the window owns it: remembered, clamped, dragged).
    var width: CGFloat = Metrics.workbenchSidebar
    @Environment(AppModel.self) private var model
    @State private var showConnection = false
    @State private var projectIcons: [String: NSImage] = [:]
    @State private var history = NavHistory<SessionKey>()
    @State private var navigating = false
    /// "Other sessions" (terminal and headless agents in folders that are not projects) starts folded.
    @AppStorage("sidebarOtherOpen") private var otherOpen = false
    private var prefs: WorkbenchPrefs { WorkbenchPrefs.shared }
    /// Folded projects, kept across launches. Legacy workspace entries are ignored.
    @AppStorage("sidebarFolded") private var foldedRaw = ""

    /// Demo and capture runs keep their own folds (never the real ones), and start with one project folded so a
    /// capture shows a folded row's mark.
    @State private var demoFolded: Set<String> = ["atlas"]

    private var folded: Set<String> {
        model.demoMode ? demoFolded : Set(foldedRaw.split(separator: "\n").map(String.init))
    }

    private func toggleFold(_ id: String) {
        var set = folded
        if !set.insert(id).inserted { set.remove(id) }
        if model.demoMode { demoFolded = set } else { foldedRaw = set.sorted().joined(separator: "\n") }
    }

    var body: some View {
        @Bindable var model = model
        @Bindable var git = model.git
        let tree = model.sidebarTree
        let sections = SidebarSections.split(tree, nativeNames: model.native.projects.map(\.name))
        VStack(alignment: .leading, spacing: 0) {
            topBar
            macRow
            VStack(alignment: .leading, spacing: 0) {
                SidebarNavRow(icon: .layoutDashboard, title: "Dashboard", selected: model.navFilter == .home && model.selected == nil && NewChatController.shared.page == nil && model.settingsSection == nil && PondsModel.shared.route == nil) { goHome() }
                createMenu
                SidebarNavRow(icon: .search, title: "Search", selected: false) { NotificationCenter.default.post(name: .squeakOpenPalette, object: nil) }
            }
            .padding(.horizontal, Space.s).padding(.top, 4).padding(.bottom, 10)
            Rectangle().fill(Theme.line).frame(height: 1)
            SidebarSectionHeader(title: "My workspaces")
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    projects(sections)
                    otherSessions(sections.otherSessions)
                }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
        .task(id: tree.projects.map(\.name)) {
            await model.refreshNativeProjects()
            let icons = await Task.detached(priority: .utility) { RepositoryIcons.read() }.value
            projectIcons = icons.compactMapValues { NSImage(data: $0) }
        }
        .task {
            // Workspaces setting up, setup failures and run scripts: briskly while one sets up, lazily otherwise.
            while !Task.isCancelled {
                await model.refreshNativeWorkspaces()
                try? await Task.sleep(for: .seconds(WorkspaceLifecycle.pollInterval(model.git.workspaces)))
            }
        }
        .task(id: model.demoMode) { if !model.demoMode { await PondsModel.shared.run(host: model.nativeHost) } }
        .onChange(of: model.native.projects, initial: true) { _, projects in PondsModel.shared.projects = projects }
        .pondSheets()
        .sheet(item: $git.logSheet) { SetupLogSheet(sheet: $0) }
        .sheet(item: $git.settingsProject) { ProjectSettingsSheet(project: $0) }
        .onChange(of: model.selected) { _, key in
            if navigating { navigating = false } else { history.visit(key) }
        }
        .onAppear { if !model.demoMode { history.visit(model.selected) } }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateBack)) { _ in goBack() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateForward)) { _ in goForward() }
    }

    /// A project's home (a pond's, or the local threads' with "Share this pond").
    private func openHome(_ name: String) {
        NewChatController.shared.hide()
        model.closeSettings()
        if model.navFilter == .usage { model.navFilter = .all }
        PondsModel.shared.route = .home(project: name)
    }

    /// The host's project behind a project row, when Squeak runs chats there (the row's "+" appears only then).
    private func nativeProject(_ project: SidebarProject) -> NativeProject? {
        NativeWorkspaceMaking.project(named: project.name, in: model.native.projects)
    }

    // MARK: Tree

    /// Asks for a branch, a PR or an issue, then makes the workspace (the New chat sheet opens on it).
    private func askSource(_ project: NativeProject, kind: String) {
        let (title, message, placeholder): (String, String, String) = switch kind {
        case "pr": ("New workspace from a pull request", "Its branch is checked out, so what you push updates the PR.", "#123 or the PR's URL")
        case "issue": ("New workspace from an issue", "A branch named after the issue, and a first message that carries it.", "#45 or the issue's URL")
        case "base": ("New workspace on top of a branch", "A new branch cut from this one, which it will merge back into.", "branch name")
        default: ("New workspace from a branch", "That branch itself is checked out in the new workspace.", "branch name")
        }
        guard let input = TextPrompt.ask(title: title, message: message, placeholder: placeholder) else { return }
        guard let source = NativeWorkspaceSource.parse(input, as: kind) else {
            let alert = NSAlert()
            alert.messageText = "Couldn't make that workspace"
            alert.informativeText = kind == "pr" || kind == "issue" ? "That isn't a number or a GitHub link." : "That isn't a branch name."
            alert.runModal()
            return
        }
        model.nativeMakeWorkspace(projectId: project.id, from: source)
    }

    // MARK: Home, new workspace, row keys

    private func goHome() { WorkbenchNav.goHome(model) }

    // MARK: Top bar, Mac row, Create

    private var topBar: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 0).frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen))   // the traffic lights; none in full screen
            barButton(.arrowLeft, "Back (⌘[)", enabled: history.canGoBack) { goBack() }
            barButton(.arrowRight, "Forward (⌘])", enabled: history.canGoForward) { goForward() }
            Spacer(minLength: 0)
            Color.clear.frame(width: PaneToggle.size, height: PaneToggle.size)   // trailing toggle (PaneToggleOverlay)
        }
        .padding(.horizontal, Space.m).frame(height: 44).background(WindowDragArea())
    }

    private func barButton(_ name: LucideName, _ help: String, enabled: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: 16, color: enabled ? Theme.muted : Theme.subtle.opacity(0.5)).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).help(help).accessibilityLabel(help)
    }

    /// "<name>'s Mac" with a chevron, the duck as its small avatar: connection, usage and Settings behind it.
    private var macRow: some View {
        Menu {
            Button(model.homeConnectionText) { showConnection = true }
            Button("Usage") { NewChatController.shared.hide(); model.closeSettings(); model.navFilter = .usage }
            Divider()
            Button("Settings…") { model.openSettings() }
        } label: {
            HStack(spacing: 10) {
                DuckMark(width: 24)
                Text(verbatim: Self.macName).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Lucide(.chevronDown, size: 12, color: Theme.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s + 4).frame(height: 40).contentShape(Rectangle())
        }
        .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain)
        .padding(.horizontal, Space.s)
        .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
        .accessibilityLabel("\(Self.macName): connection, usage and settings")
    }

    private static var macName: String {
        let first = NSFullUserName().split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty ? "This Mac" : "\(first)'s Mac"
    }

    /// Create: a workspace in a project, or open or clone a repository.
    private var createMenu: some View {
        Menu {
            let projects = model.native.projects
            ForEach(projects, id: \.id) { p in
                Button("New workspace in \(p.name)") { model.nativeMakeWorkspace(projectId: p.id) }
                    .disabled(model.native.makingWorkspaceIn != nil)
            }
            if !projects.isEmpty { Divider() }
            Button("Open project…") { ProjectActions.shared.open(model) }
            Button("Clone repository…") { ProjectActions.shared.clone(model) }
            if PondsModel.shared.available {
                Divider()
                Button("Join a pond…") { PondsModel.shared.sheet = .join }
            }
        } label: {
            SidebarNavLabel(icon: .plus, title: "Create")
        }
        .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain)
        .disabled(ProjectActions.shared.busy)
        .help("New workspace, open a project, clone a repository")
    }

    // MARK: Back, forward, Home

    private func goBack() { if let place = history.back() { open(place) } }
    private func goForward() { if let place = history.forward() { open(place) } }

    private func open(_ place: SessionKey?) {
        PondsModel.shared.route = nil
        navigating = true
        if let place, model.sessions.contains(where: { $0.key == place }) { model.select(place) } else { goHome() }
    }

    /// The workspace's open chat's diff, when Squeak has read it (the Changes store of a chat already visited): no
    /// polling for rows nobody looks at.
    private func diffStat(_ workspace: SidebarWorkspace) -> (added: Int, removed: Int)? {
        guard let chat = workspace.chats.first(where: { $0.key == model.selected }) ?? workspace.chats.first,
              let c = model.changesStore(for: chat.key.hostSessionId).changes, !c.files.isEmpty else { return nil }
        return (c.added, c.removed)
    }

    private func toggleRead(_ workspace: SidebarWorkspace) {
        let unread = workspace.chats.contains { model.isUnread($0) }
        for chat in workspace.chats where chat.state == .finished { model.setSeen(chat, seen: unread) }
    }

    private func rowKey(_ key: Character, _ workspace: SidebarWorkspace) {
        switch key {
        case "p": prefs.togglePin(workspace.id)
        case "r": toggleRead(workspace)
        default: break
        }
    }

    private func openWorkspace(_ workspace: SidebarWorkspace) {
        PondsModel.shared.route = nil
        // Keep the open chat when clicking its own workspace; otherwise open the newest chat.
        if let selected = model.selected, workspace.chats.contains(where: { $0.key == selected }) {
            NewChatController.shared.hide()
            model.closeSettings()
            model.navFilter = .all
        } else if let chat = workspace.chats.first { model.select(chat.key) }
    }

    @ViewBuilder private func projects(_ sections: SidebarSections) -> some View {
        let tree = sections.projects
        let names = tree.map(\.name) + model.native.projects.map(\.name).filter { name in
            !tree.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
        }
        ForEach(names, id: \.self) { name in
            let project = tree.first { $0.name == name }
            let native = NativeWorkspaceMaking.project(named: name, in: model.native.projects)
            let workspaces = project?.workspaces ?? []
            let emptyWorkspaces = model.git.workspaces.filter { w in
                w.projectId == native?.id && w.state != "archived" && !workspaces.contains { ws in ws.chats.contains { $0.cwd == w.path } }
            }
            let projectFolded = folded.contains(name)
            let listed = workspaces.count + emptyWorkspaces.count
            FoldRow(
                title: name, depth: 0, glyph: String(name.prefix(1)).uppercased(), icon: projectIcons[name],
                addWorkspace: native.map { p in { model.nativeMakeWorkspace(projectId: p.id) } },
                adding: native.map { model.native.makingWorkspaceIn == $0.id } ?? false,
                // The count shows only when the rows are folded away or there are none to show.
                count: (projectFolded || listed == 0) ? max(project?.chatCount ?? 0, listed) : nil,
                // With ponds on, the row opens the project's home and the chevron folds its threads; without, the row folds.
                homeSelected: PondsModel.shared.homeProject == name,
                needs: PondsModel.shared.pond(named: name)?.needsYou ?? 0,
                onDisclose: PondsModel.shared.available ? { toggleFold(name) } : nil,
                folded: projectFolded,
                pondId: PondsModel.shared.pond(named: name)?.id
            ) { if PondsModel.shared.available { openHome(name) } else { toggleFold(name) } }
            .padding(.top, 6)
            .contextMenu {
                if let native {
                    Button("New workspace from branch…") { askSource(native, kind: "branch") }
                    Button("New workspace on top of branch…") { askSource(native, kind: "base") }
                    Button("New workspace from pull request…") { askSource(native, kind: "pr") }
                    Button("New workspace from issue…") { askSource(native, kind: "issue") }
                    Divider()
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: native.rootPath)]) }
                    Button("Project settings…") { model.git.settingsProject = native }
                }
            }
            if !projectFolded {
                ForEach(WorkspaceNavigation.pinnedFirst(workspaces, pins: prefs.pins.ids)) { workspace in
                    let nativeWorkspace = model.nativeWorkspace(of: workspace)
                    let run = nativeWorkspace.flatMap { model.git.runs[$0.id] }
                    // The row says what the chat is called; the workspace's own name is in the tooltip.
                    let newest = workspace.chats.first
                    FoldRow(title: newest.map { model.workbenchTitle($0) } ?? workspace.name, depth: 1,
                        help: [workspace.name, workspace.branchLabel].compactMap { $0 }.joined(separator: " · "),
                        selected: workspace.chats.contains { $0.key == model.selected },
                        running: workspace.chats.contains { $0.state == .working },
                        unread: workspace.chats.contains { model.isUnread($0) },
                        lifecycle: nativeWorkspace.flatMap { WorkspaceLifecycle.mark($0.state) },
                        runPort: run?.running == true ? (run?.port ?? nativeWorkspace?.port) : nil,
                        pinned: prefs.pins.contains(workspace.id),
                        diff: diffStat(workspace),
                        onKey: { key in rowKey(key, workspace) }) {
                        openWorkspace(workspace)
                    }
                    .contextMenu {
                        Button(prefs.pins.contains(workspace.id) ? "Unpin" : "Pin to top") { prefs.togglePin(workspace.id) }
                        Button(workspace.chats.contains { model.isUnread($0) } ? "Mark as read" : "Mark as unread") { toggleRead(workspace) }
                        if nativeWorkspace != nil { Divider() }
                        if let nativeWorkspace { WorkspaceMenu(workspace: nativeWorkspace) }
                    }
                }
                ForEach(emptyWorkspaces) { workspace in
                    FoldRow(title: workspace.name, depth: 1,
                        help: workspace.branch,
                        lifecycle: WorkspaceLifecycle.mark(workspace.state)) {
                        NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: workspace.projectId, workspaceId: workspace.id))
                    }
                    .contextMenu { WorkspaceMenu(workspace: workspace) }
                }
            }
        }
        if names.isEmpty && sections.otherSessions.isEmpty {
            Text("Open a project to see its worktrees.").font(Typo.body).foregroundStyle(Theme.subtle).padding(Space.s)
        }
    }

    /// Terminal and headless agents in folders that are not projects: one folded group at the bottom.
    @ViewBuilder private func otherSessions(_ sessions: [HostSession]) -> some View {
        if !sessions.isEmpty {
            Button { otherOpen.toggle() } label: {
                HStack(spacing: 8) {
                    Lucide(otherOpen ? .chevronDown : .chevronRight, size: 12, color: Theme.subtle).frame(width: 18)
                    Text(SidebarSections.otherTitle).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                    Text("\(sessions.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.s).frame(height: 32).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.top, 10)
            .accessibilityLabel("\(SidebarSections.otherTitle), \(sessions.count), \(otherOpen ? "expanded" : "folded")")
            if otherOpen {
                ForEach(sessions) { WorkbenchChatRow(session: $0, indent: 1) }
            }
        }
    }

    // MARK: Footer

    /// A dashed badge (Squeak's version) at the left; help and Settings at the right.
    private var footer: some View {
        SidebarAppFooter(updater: model.updater,
            openShortcuts: { NotificationCenter.default.post(name: .squeakOpenShortcuts, object: nil) },
            openSettings: { model.openSettings() })
    }

}

// MARK: - Rows

/// A project row (icon, bold name, a count only when folded or empty, a "+" always at the edge: no chevrons) or a
/// workspace row under it (branch icon, or the matrix glyph while it works; the chat's title; the diff stat in small
/// mono at the right). The selected row is a filled rounded pill. Running uses the glyph; unread uses weight.
private struct FoldRow: View {
    let title: String
    let depth: Int
    /// A project's letter, drawn as a plain monochrome glyph when it has no icon of its own.
    var glyph: String?
    var icon: NSImage?
    var help: String?
    var selected = false
    var running = false
    var unread = false
    /// A project row's "+" (new workspace), always visible; nil on every other row.
    var addWorkspace: (() -> Void)?
    var adding = false
    /// A project row's worktree count, quiet and tabular after its name.
    var count: Int?
    /// A native workspace still setting up (the quiet loader) or whose setup failed (the failed mark), in the stat's slot.
    var lifecycle: WorkspaceLifecycle.Mark?
    /// The port of a running run script, a quiet mono tag.
    var runPort: Int?
    var pinned = false
    /// The workspace's lines added and removed, when read.
    var diff: (added: Int, removed: Int)?
    /// Ponds: this project's home is open; what in it waits on you; the chevron that folds the threads; whether folded.
    var homeSelected = false
    var needs = 0
    var onDisclose: (() -> Void)?
    var folded = false
    /// The pond behind a project row: its icon sits on the pond's tint.
    var pondId: String?
    /// P and R while the row has focus (pin, read or unread).
    var onKey: ((Character) -> Void)?
    let action: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .trailing) { row; HStack(spacing: 0) { disclosure; plus } }
            .onHover { hovering = $0 }
            .modifier(RowKeys(onKey: onKey, focused: $focused))
    }

    @ViewBuilder private var disclosure: some View {
        if depth == 0, let onDisclose {
            Button(action: onDisclose) {
                Lucide(folded ? .chevronRight : .chevronDown, size: 12, color: Theme.muted).frame(width: 38, height: 38).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(folded ? "Show threads" : "Hide threads")
            .accessibilityLabel(folded ? "Show \(title)'s threads" : "Hide \(title)'s threads")
        }
    }

    @ViewBuilder private var plus: some View {
        if let addWorkspace {
            Button(action: addWorkspace) {
                Group {
                    if adding { GlyphLoadingField() } else { Lucide(.plus, size: 16, color: Theme.muted) }
                }
                .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(adding)
            .padding(.trailing, 6)
            .help("New workspace in \(title)")
            .accessibilityLabel("New workspace in \(title)")
        }
    }

    private var row: some View {
        Button(action: { focused = true; action() }) {
            HStack(spacing: 10) {
                if depth == 0 {
                    Group {
                        if let icon {
                            Image(nsImage: icon).resizable().scaledToFit().frame(width: 20, height: 20)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        } else {
                            Text(glyph ?? "").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 20, height: 20)
                        }
                    }
                    // A pond's icon sits on its own soft tint; a project that is not one stays plain.
                    .padding(pondId == nil ? 0 : 3)
                    .background(pondId == nil ? .clear : PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .padding(pondId == nil ? 0 : -3)
                } else if running {
                    // Ink keeps the shared matrix visible in light and dark.
                    WorkingGlyph(width: 20, height: 15).frame(width: 20).accessibilityLabel("Working")
                } else {
                    Lucide(.gitBranch, size: 15, color: Theme.muted).frame(width: 20)
                }
                Text(verbatim: title).font(.system(size: 14, weight: depth == 0 || unread ? .semibold : .regular))
                    .foregroundStyle(depth == 0 || selected || unread ? Theme.ink : Theme.muted).lineLimit(1)
                    .truncationMode(.tail)
                if depth == 0, let count {
                    Text("\(count)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
                        .accessibilityLabel("\(count) workspaces")
                }
                if depth == 0, needs > 0 {
                    Text("\(needs)").font(.system(size: 12, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.warning)
                        .accessibilityLabel("\(needs) waiting on you")
                }
                if pinned { Lucide(.pin, size: 11, color: Theme.subtle).accessibilityLabel("Pinned") }
                Spacer(minLength: 0)
                if depth == 1 { trailing }
            }
            .padding(.leading, depth == 0 ? 10 : 22).padding(.trailing, depth == 0 ? (onDisclose != nil ? 78 : 40) : 10)
            .frame(height: depth == 0 ? 38 : 36)
            .background(selected || homeSelected ? Theme.selected : (hovering && depth == 1 ? Theme.selected.opacity(0.5) : .clear), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(alignment: .leading) {
                // The selected pond's accent: duck (dark) or duck-text (light), a short bar at the row's edge.
                if homeSelected { Capsule().fill(PondColour.accent).frame(width: 3, height: 18).padding(.leading, 2) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help ?? "")
        .accessibilityLabel([title, depth == 0 ? "project" : "workspace", running ? "Working" : (unread ? "Finished, not opened yet" : nil)].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private var trailing: some View {
        if lifecycle == .setupFailed {
            LifecycleSlot(mark: .setupFailed)
        } else if lifecycle == .settingUp {
            WorkingMark(quiet: true).frame(width: 28, height: 16, alignment: .trailing).help(WorkspaceLifecycle.words(.settingUp))
        } else if let diff, diff.added + diff.removed > 0 {
            HStack(spacing: 5) {
                Text("+\(DiffStatFormat.abbreviate(diff.added))").foregroundStyle(Theme.working)
                Text("−\(DiffStatFormat.abbreviate(diff.removed))").foregroundStyle(Theme.negative)
            }
            .font(.system(size: 11, design: .monospaced)).lineLimit(1).fixedSize()
            .accessibilityLabel("\(diff.added) lines added, \(diff.removed) removed")
        } else if let runPort {
            Text(verbatim: ":\(runPort)").font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.subtle).help("Running on localhost:\(runPort)")
        }
    }
}

/// A chat is one line, 28pt in every state (§8.2, §8.10): its title, the Conductor mark where Conductor holds it,
/// and the trailing slot, the age or in its place the one mark. A waiting or unread chat has its title in `ink`
/// semibold; every other is regular `muted`; the selected row is `ink`. The tooltip and VoiceOver carry the words.
struct WorkbenchChatRow: View {
    let session: HostSession
    var indent = 0
    /// A search hit's matched text, shown as the tooltip so the row stays one line.
    var snippet: String?
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var selected: Bool { model.selected == session.key && model.navFilter != .usage }

    var body: some View {
        let mark = model.mark(for: session)
        let loud = mark?.kind == .waiting || mark?.kind == .unread
        Button { model.select(session.key) } label: {
            HStack(spacing: 6) {
                Text(verbatim: model.workbenchTitle(session)).font(loud ? Typo.label : Typo.body)
                    .foregroundStyle(selected || loud ? Theme.ink : Theme.muted).lineLimit(1)
                if session.showsConductorBadge { ConductorMarker() }
                Spacer(minLength: 0)
                MarkSlot(mark: mark, age: session.lastActivityAt)
            }
            .padding(.leading, Space.s + CGFloat(indent) * 16).padding(.trailing, Space.s)
            .frame(height: Metrics.chatRow)
            .background(selected ? Theme.selected.opacity(0.75) : (hovering ? Theme.selected.opacity(0.4) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(snippet ?? "")
        .contextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SessionText.accessibility(title: model.workbenchTitle(session), mark: mark, last: session.lastActivityAt))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Conductor's own app icon (the bundled `agent-conductor.png`, the one the iPhone uses) after a title, 14pt,
/// where Conductor holds the chat. Tooltip "Conductor chat".
struct ConductorMarker: View {
    var size: CGFloat = 14

    var body: some View {
        AgentMark(.conductor, size: size).help("Conductor chat")
    }
}

/// Lets a drag on empty chrome move the window (the toolbar is gone, so the title bar is ours).
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ view: NSView, context: Context) {}
    private final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
    }
}

/// One line of text from the person, in a native sheet-less alert: for the short asks of a menu item.
@MainActor
enum TextPrompt {
    static func ask(title: String, message: String, placeholder: String) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = placeholder
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }
}


/// P and R on a focused sidebar row (pin, read or unread). The row takes focus when it is clicked.
private struct RowKeys: ViewModifier {
    let onKey: ((Character) -> Void)?
    var focused: FocusState<Bool>.Binding

    func body(content: Content) -> some View {
        if let onKey {
            content.focusable().focused(focused).focusEffectDisabled()
                .onKeyPress(characters: CharacterSet(charactersIn: "pr")) { press in
                    guard press.modifiers.isEmpty, let c = press.characters.first else { return .ignored }
                    onKey(c)
                    return .handled
                }
        } else { content }
    }
}

/// The label of a top row of the sidebar (Dashboard, Create, Search, and Settings' pages): icon and title, no key
/// hints. The icon is a Lucide name or any view drawn in the 20 pt icon slot.
struct SidebarNavLabel<Icon: View>: View {
    let title: String
    @ViewBuilder let icon: Icon

    var body: some View {
        HStack(spacing: 12) {
            icon.frame(width: 20)
            Text(title).font(.system(size: 15)).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.s + 2).frame(height: 38).contentShape(Rectangle())
    }
}

extension SidebarNavLabel where Icon == Lucide {
    init(icon: LucideName, title: String) {
        self.init(title: title) { Lucide(icon, size: 17, color: Theme.muted) }
    }
}

/// A section header of a sidebar list ("My workspaces", Settings' groups).
struct SidebarSectionHeader: View {
    let title: String
    var body: some View {
        Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
            .padding(.horizontal, Space.l).padding(.top, 14).padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

struct SidebarNavRow<Icon: View>: View {
    let title: String
    var selected = false
    let action: () -> Void
    @ViewBuilder let icon: Icon

    var body: some View {
        Button(action: action) {
            SidebarNavLabel(title: title) { icon }
                .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension SidebarNavRow where Icon == Lucide {
    init(icon: LucideName, title: String, selected: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, selected: selected, action: action) { Lucide(icon, size: 17, color: Theme.muted) }
    }
}
