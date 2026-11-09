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
    @FocusState private var searchFocused: Bool
    @State private var showConnection = false
    @State private var projectQuery = ""
    @State private var projectIcons: [String: NSImage] = [:]
    @State private var projectProblem: String?
    @State private var openingProject = false
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
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer()
                Button { NotificationCenter.default.post(name: .squeakToggleSidebar, object: nil) } label: {
                    Image(systemName: "sidebar.left").font(.system(size: 15)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).help("Hide sidebar (⌘B)").accessibilityLabel("Hide sidebar")
            }
            .padding(.horizontal, Space.m).frame(height: 44).background(WindowDragArea())
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 9) {
                    DuckMark(width: 28)
                    Text("Squeak").font(.system(size: 18, weight: .semibold)).foregroundStyle(Theme.ink)
                }
                .padding(.bottom, 2)
                SidebarNavRow(icon: .house, title: "Home", key: "⇧⌘H", selected: model.navFilter == .home && model.selected == nil && NewChatController.shared.page == nil && model.settingsSection == nil) { goHome() }
                newWorkspaceRow
                SidebarSearchField(prompt: "Search projects…", text: $projectQuery, focused: $searchFocused, accessibilityLabel: "Search projects and worktrees")
                Button(action: openProject) {
                    HStack(spacing: 9) {
                        if openingProject { GlyphLoadingField().frame(width: 16, height: 18) }
                        else { Lucide(.plus, size: 16, color: Theme.muted) }
                        Text("Open project…").font(.system(size: 14))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.ink).frame(height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(openingProject).help("Open a repository folder")
                Button(action: cloneProject) {
                    HStack(spacing: 9) {
                        Lucide(.gitBranch, size: 16, color: Theme.muted)
                        Text("Clone repository…").font(.system(size: 14))
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.ink).frame(height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(openingProject).help("Clone from GitHub or a git URL into ~/squeak/repos")
            }
            .padding(.horizontal, Space.m).padding(.bottom, 16)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    projects(tree)
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
        .alert("Couldn't open project", isPresented: Binding(get: { projectProblem != nil }, set: { if !$0 { projectProblem = nil } })) {
            Button("OK") { projectProblem = nil }
        } message: { Text(projectProblem ?? "") }
        .task {
            // Workspaces setting up, setup failures and run scripts: briskly while one sets up, lazily otherwise.
            while !Task.isCancelled {
                await model.refreshNativeWorkspaces()
                try? await Task.sleep(for: .seconds(WorkspaceLifecycle.pollInterval(model.git.workspaces)))
            }
        }
        .sheet(item: $git.logSheet) { SetupLogSheet(sheet: $0) }
        .sheet(item: $git.settingsProject) { ProjectSettingsSheet(project: $0) }
        .background {
            // ⌘K is the command palette now; its "Search chats" item lands here and focuses the field.
            Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
                .onReceive(NotificationCenter.default.publisher(for: .squeakFocusSidebarSearch)) { _ in searchFocused = true }
        }
    }

    /// The host's project behind a project row, when Squeak runs chats there (the row's "+" appears only then).
    private func nativeProject(_ project: SidebarProject) -> NativeProject? {
        NativeWorkspaceMaking.project(named: project.name, in: model.native.projects)
    }

    // MARK: Tree

    private func matches(_ name: String) -> Bool {
        projectQuery.isEmpty || name.localizedCaseInsensitiveContains(projectQuery)
    }

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
            projectProblem = kind == "pr" || kind == "issue" ? "That isn't a number or a GitHub link." : "That isn't a branch name."
            return
        }
        model.nativeMakeWorkspace(projectId: project.id, from: source)
    }

    private func cloneProject() {
        guard let url = TextPrompt.ask(
            title: "Clone a repository", message: "owner/repo from GitHub, or a git URL. It goes to ~/squeak/repos.",
            placeholder: "owner/repo")
        else { return }
        openingProject = true
        Task {
            let (project, problem) = await model.nativeCloneProject(url: url)
            openingProject = false
            if let project {
                await model.refreshNativeProjects()
                await model.refreshNativeWorkspaces()
                var set = folded
                set.remove(project.name)
                if model.demoMode { demoFolded = set } else { foldedRaw = set.sorted().joined(separator: "\n") }
                projectQuery = ""
            } else { projectProblem = problem ?? "Squeak couldn't clone that repository." }
        }
    }

    private func openProject() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open project"
        panel.message = "Choose a git repository. Its worktrees will appear in the sidebar."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        openingProject = true
        Task {
            let (project, problem) = await model.nativeAddProject(path: url.path)
            openingProject = false
            if let project {
                await model.refreshNativeProjects()
                await model.refreshNativeWorkspaces()
                var set = folded
                set.remove(project.name)
                if model.demoMode { demoFolded = set } else { foldedRaw = set.sorted().joined(separator: "\n") }
                projectQuery = ""
            } else { projectProblem = problem ?? "Squeak couldn't open that repository." }
        }
    }

    // MARK: Home, new workspace, row keys

    private func goHome() { WorkbenchNav.goHome(model) }

    /// New workspace (⇧⌘N in the palette): one project makes it at once, several ask which in a menu.
    @ViewBuilder private var newWorkspaceRow: some View {
        let projects = model.native.projects
        let label = SidebarNavLabel(icon: .squarePen, title: "New workspace", key: "⇧⌘N")
        if projects.count == 1, let only = projects.first {
            Button { model.nativeMakeWorkspace(projectId: only.id) } label: { label }.buttonStyle(.plain)
                .disabled(model.native.makingWorkspaceIn != nil)
        } else if projects.isEmpty {
            Button { openProject() } label: { label }.buttonStyle(.plain).help("Open a project first")
        } else {
            Menu {
                ForEach(projects, id: \.id) { p in Button(p.name) { model.nativeMakeWorkspace(projectId: p.id) } }
            } label: { label }
            .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain)
            .disabled(model.native.makingWorkspaceIn != nil)
        }
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
        // Keep the open chat when clicking its own workspace; otherwise open the newest chat.
        if let selected = model.selected, workspace.chats.contains(where: { $0.key == selected }) {
            NewChatController.shared.hide()
            model.closeSettings()
            model.navFilter = .all
        } else if let chat = workspace.chats.first { model.select(chat.key) }
    }

    @ViewBuilder private func projects(_ tree: SidebarTree) -> some View {
        let names = tree.projects.map(\.name) + model.native.projects.map(\.name).filter { name in
            !tree.projects.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
        }
        ForEach(names, id: \.self) { name in
            let project = tree.projects.first { $0.name == name }
            let native = NativeWorkspaceMaking.project(named: name, in: model.native.projects)
            let workspaces = project?.workspaces ?? []
            let emptyWorkspaces = model.git.workspaces.filter { w in
                w.projectId == native?.id && w.state != "archived" && !workspaces.contains { ws in ws.chats.contains { $0.cwd == w.path } }
            }
            let visible = matches(name) || workspaces.contains { matches($0.name) } || emptyWorkspaces.contains { matches($0.name) }
            if visible {
                let projectFolded = projectQuery.isEmpty && folded.contains(name)
                FoldRow(
                    title: name, folded: projectFolded, depth: 0, mark: projectFolded ? project?.foldedMark : nil,
                    tile: String(name.prefix(1)).uppercased(), icon: projectIcons[name],
                    running: projectFolded && workspaces.contains { $0.chats.contains { $0.state == .working } },
                    unread: projectFolded && workspaces.contains { $0.chats.contains { model.isUnread($0) } },
                    addWorkspace: native.map { p in { model.nativeMakeWorkspace(projectId: p.id) } },
                    adding: native.map { model.native.makingWorkspaceIn == $0.id } ?? false,
                    count: workspaces.count + emptyWorkspaces.count
                ) { toggleFold(name) }
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
                    ForEach(WorkspaceNavigation.pinnedFirst(workspaces.filter { matches(name) || matches($0.name) }, pins: prefs.pins.ids)) { workspace in
                        let nativeWorkspace = model.nativeWorkspace(of: workspace)
                        let run = nativeWorkspace.flatMap { model.git.runs[$0.id] }
                        FoldRow(title: workspace.name, folded: false, depth: 1, mark: workspace.foldedMark, tile: nil,
                            subtitle: workspace.branchLabel, selected: workspace.chats.contains { $0.key == model.selected },
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
                    ForEach(emptyWorkspaces.filter { matches(name) || matches($0.name) }) { workspace in
                        FoldRow(title: workspace.name, folded: false, depth: 1, mark: nil, tile: nil,
                            subtitle: workspace.branch == workspace.name ? nil : workspace.branch,
                            lifecycle: WorkspaceLifecycle.mark(workspace.state)) {
                            NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: workspace.projectId, workspaceId: workspace.id))
                        }
                        .contextMenu { WorkspaceMenu(workspace: workspace) }
                    }
                }
            }
        }
        if names.isEmpty {
            Text("Open a project to see its worktrees.").font(Typo.body).foregroundStyle(Theme.subtle).padding(Space.s)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: Space.s) {
            Button { showConnection.toggle() } label: {
                HStack(spacing: Space.s) {
                    Image(systemName: "laptopcomputer").font(.system(size: 15)).foregroundStyle(Theme.muted)
                    Text(model.homeLoaded && !model.isConnected ? model.homeConnectionText : "This Mac")
                        .font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection: \(model.homeConnectionText)")
            .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
            footerButton(.gauge, "Usage") { NewChatController.shared.hide(); model.closeSettings(); model.navFilter = .usage }
            footerButton(.settings, "Settings (⌘,)") { model.openSettings() }
        }
        .padding(.horizontal, Space.m).frame(height: 56)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func footerButton(_ name: LucideName, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: Metrics.icon + 2, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(help)
        .help(help)
    }
}

// MARK: - Rows

/// Projects disclose their worktrees; worktrees select their conversation without expanding.
/// Artwork and larger labels distinguish the two levels. Running uses glyphs; unread uses weight.
private struct FoldRow: View {
    let title: String
    let folded: Bool
    let depth: Int
    let mark: FoldedMark?
    let tile: String?
    var icon: NSImage?
    var subtitle: String?
    var selected = false
    var running = false
    var unread = false
    var time: Date?
    /// A project row's "+" (new workspace), drawn over the age's slot on hover; nil on every other row.
    var addWorkspace: (() -> Void)?
    var adding = false
    /// A project row's worktree count, quiet and tabular at the trailing edge.
    var count: Int?
    /// A native workspace still setting up (the quiet loader) or whose setup failed (the failed mark), in the age's slot.
    var lifecycle: WorkspaceLifecycle.Mark?
    /// The port of a running run script, a quiet mono tag after the branch.
    var runPort: Int?
    var pinned = false
    /// The workspace's lines added and removed, when read.
    var diff: (added: Int, removed: Int)?
    /// P and R while the row has focus (pin, read or unread).
    var onKey: ((Character) -> Void)?
    let action: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    var body: some View {
        ZStack(alignment: .trailing) { row; plus }
            .onHover { hovering = $0 }
            .modifier(RowKeys(onKey: onKey, focused: $focused))
    }

    @ViewBuilder private var plus: some View {
        if let addWorkspace {
            Button(action: addWorkspace) {
                Group {
                    if adding { GlyphLoadingField() } else { Lucide(.plus, size: 13, color: Theme.muted) }
                }
                .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(hovering || adding ? 1 : 0)
            .disabled(adding)
            .padding(.trailing, 4)
            .help("New workspace in \(title)")
            .accessibilityLabel("New workspace in \(title)")
        }
    }

    private var row: some View {
        Button(action: { focused = true; action() }) {
            HStack(spacing: 6) {
                if depth == 0 {
                    Lucide(folded ? .chevronRight : .chevronDown, size: 10, color: Theme.subtle).frame(width: 12)
                }
                if let icon {
                    Image(nsImage: icon).resizable().scaledToFit().frame(width: 18, height: 18)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                } else if let tile {
                    Text(tile).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                        .frame(width: 18, height: 18)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 4))
                        .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.line))
                } else {
                    Lucide(.gitBranch, size: 14, color: Theme.muted).frame(width: 18)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title).font(.system(size: 13, weight: depth == 0 || selected || unread ? .semibold : .regular))
                        .foregroundStyle(depth == 0 || selected || unread ? Theme.ink : Theme.muted).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty {
                        Text(verbatim: subtitle).font(.system(size: 10.5)).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.middle)
                    }
                }
                if pinned { Lucide(.pin, size: 11, color: Theme.subtle).accessibilityLabel("Pinned") }
                if let diff, diff.added + diff.removed > 0 {
                    HStack(spacing: 4) {
                        Text("+\(diff.added)").foregroundStyle(Theme.working)
                        Text("−\(diff.removed)").foregroundStyle(Theme.negative)
                    }
                    .font(Typo.meta).monospacedDigit().lineLimit(1)
                    .accessibilityLabel("\(diff.added) lines added, \(diff.removed) removed")
                }
                if let runPort {
                    Text(verbatim: ":\(runPort)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle).help("Running on localhost:\(runPort)")
                }
                Spacer(minLength: 0)
                if lifecycle == .setupFailed {
                    LifecycleSlot(mark: .setupFailed)
                } else if lifecycle == .settingUp || running {
                    // The one Working mark, in the fixed 28x16 slot; the project's "+" replaces it on hover.
                    WorkingMark(quiet: lifecycle == .settingUp).frame(width: 28, height: 16, alignment: .trailing)
                        .help(lifecycle == .settingUp ? WorkspaceLifecycle.words(.settingUp) : "Working")
                        .accessibilityLabel(lifecycle == .settingUp ? WorkspaceLifecycle.words(.settingUp) : "Working")
                        .opacity(addWorkspace != nil && (hovering || adding) ? 0 : 1)
                } else if let count {
                    Text("\(count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                        .frame(width: 28, height: 16, alignment: .trailing)
                        .opacity(addWorkspace != nil && (hovering || adding) ? 0 : 1)
                        .accessibilityLabel("\(count) worktrees")
                }
            }
            .padding(.leading, depth == 0 ? 8 : 24).padding(.trailing, Space.s)
            .frame(height: depth == 0 ? 28 : (subtitle == nil ? 28 : 38))
            .background(selected ? Theme.selected.opacity(0.75) : (hovering ? Theme.selected.opacity(0.4) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([title, depth == 0 ? (folded ? "folded" : "expanded") : "worktree", running ? "Running" : (unread ? "Finished, not opened yet" : nil)].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
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

/// The label of a top row of the sidebar (Home, New workspace): icon, title, its key quietly at the end.
struct SidebarNavLabel: View {
    let icon: LucideName
    let title: String
    let key: String

    var body: some View {
        HStack(spacing: 9) {
            Lucide(icon, size: 16, color: Theme.muted)
            Text(title).font(.system(size: 14))
            Spacer(minLength: 0)
            Text(key).font(Typo.meta).foregroundStyle(Theme.subtle).accessibilityHidden(true)
        }
        .foregroundStyle(Theme.ink).frame(height: 28).contentShape(Rectangle())
    }
}

struct SidebarNavRow: View {
    let icon: LucideName
    let title: String
    let key: String
    var selected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { SidebarNavLabel(icon: icon, title: title, key: key) }
            .buttonStyle(.plain)
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
