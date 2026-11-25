import AppKit
import SqueakIcons
import SqueakMacCore
import Heresay
import SwiftUI

// DESIGN.md §8.10, the centre: a 44pt header (project / workspace, branch chip, inspector toggle), a 36pt strip
// of the workspace's chats as tabs, then the chat itself (`SessionDetail`, restyled in a later step).

struct WorkbenchCentre: View {
    static func centre(_ files: FilesModel?) -> KeyFocus.Centre {
        if files?.review.isOpen == true { return .review }
        return files?.activePath != nil ? .file : .chat
    }

    @Environment(AppModel.self) private var model
    let sidebarHidden: Bool
    /// The right zone is on screen (its toggle sits in this header's place when it is not).
    let inspectorOpen: Bool
    /// The right zone's tab is Code, which carries the git cluster itself.
    let toggleSidebar: () -> Void

    /// A pond's home or a thread from it is a layer over the workbench (Ponds/PondHome.swift): the workbench, with its
    /// chat, scroll and focus, stays mounted underneath, so coming back to the chat finds it as it was.
    var body: some View {
        // The classic artifact layer uses location; new-layout items use the Pond strip.
        let newDuck = WorkPaneActions.isDuckView(model.selectedSession)
        let artifact: (pond: String, path: String)? = newDuck ? nil : model.location.artifactPath.flatMap { path in model.location.pondKey.map { (pond: $0, path: path) } }
        // An artifact opens as a tab of its pond's chat strip; only a pond with no chat shows it as a layer.
        let held = artifact.flatMap { model.artifactContext(pond: $0.pond) } != nil
        let layer = artifact != nil && !held
        let pondPage = held ? nil : PondRoute(model.baseLocation)
        let bar = barContext(pondPage: pondPage, newDuck: newDuck && !layer)
        // New layout: the one top bar is hosted here, above every page, so it keeps its identity (never moves or rebuilds)
        // between the Dashboard, the Room, items and a Duck.
        VStack(spacing: 0) {
            if let bar {
                PondSharedHeader(key: bar.workspace.pond, projectId: bar.workspace.project.id, member: bar.member,
                                 leadingInset: CGFloat(PondPageChrome.headerInset(sidebarClearance: Double(sidebarClearance))),
                                 itemShowing: bar.itemShowing, inDuck: bar.inDuck, workspace: bar.workspace, strip: bar.strip)
            }
            ZStack {
                workbench.workbenchLayer(hidden: pondPage != nil || layer)
                if let route = pondPage {
                    PondRouteView(route: route, sidebarHidden: sidebarHidden, barHosted: bar != nil).heresayPrivate()
                        .workbenchLayer(hidden: layer)
                }
                // An artifact of a pond with no chat: a layer over the pond page, closed by its back control.
                if let artifact, layer {
                    ArtifactViewerPage(pond: artifact.pond, path: artifact.path, sidebarHidden: sidebarHidden, inspectorOpen: inspectorOpen)
                        .id(artifact.path)
                        .transition(.opacity)
                }
            }
        }
    }

    private struct BarContext {
        let workspace: PondWorkspace
        let strip: PondWorkspaceStrip
        var member = false
        var itemShowing = false
        var inDuck = false
    }

    private var sidebarClearance: CGFloat {
        sidebarHidden ? PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size : 0
    }

    /// What the one top bar needs: a Pond's Dashboard or Room, or the Pond of the Duck whose chat is showing; nil elsewhere.
    private func barContext(pondPage: PondRoute?, newDuck: Bool) -> BarContext? {
        if let pondPage {
            guard case .home(let key) = pondPage, let room = PondRouteView.roomProject(key),
                  let workspace = PondWorkspace(pond: key) else { return nil }
            let strip = workspace.strip(place: PondPageChrome.rowPlace(page: RoomViewPref.shared.mode(for: key)), store: model.tabStore)
            return BarContext(workspace: workspace, strip: strip, member: room.member, itemShowing: strip.currentItem != nil)
        }
        guard newDuck, let shell = model.selectedSession, let key = PondsModel.shared.key(of: shell),
              let workspace = PondWorkspace(pond: key) else { return nil }
        let strip = workspace.strip(place: AppModel.duckRowPlace(shell), store: model.tabStore)
        return BarContext(workspace: workspace, strip: strip, itemShowing: strip.currentItem != nil, inDuck: true)
    }

    @ViewBuilder private var workbench: some View {
        let focus = model.focus
        let showingCompose = focus.composePage != nil
        let usage = focus.page == .usage
        let newDuck = WorkPaneActions.isDuckView(model.selectedSession)
        // The chat the body keeps mounted under a creation page; the shell below follows the page.
        let artifact: (pond: String, path: String)? = newDuck ? nil : model.location.artifactPath.flatMap { path in model.location.pondKey.map { (pond: $0, path: path) } }
        let artifactChat = artifact.flatMap { model.artifactContext(pond: $0.pond) }
        let bodyChat = usage ? nil : (artifactChat ?? model.selectedSession)
        let chat = showingCompose ? nil : bodyChat
        // The shell (header and tab strip) is one structure over chat and New thread: only the body below switches.
        // A New thread page inside a workspace keeps the workspace's header and strip (the page is a placeholder tab).
        let composePlace = focus.composePage == .newThread ? model.centreStripPlace(for: model.location) : nil
        // A chat the active list does not carry (an earlier duck opened, or one just started) still has its place.
        let place = composePlace ?? chat.flatMap { model.stripPlace(of: $0.key) }
        let shell: HostSession? = composePlace.flatMap { p in
            model.selectedSession.flatMap { s in p.workspace.chats.contains { $0.key == s.key } ? s : nil } ?? p.workspace.chats.first
        } ?? chat
        // The workspace's open files (Files tab), which sit in the tab strip beside its chats.
        let files = shell?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        // The chat layer's own files: the chat's workspace, also while a creation page covers it.
        let bodyFiles = showingCompose ? bodyChat?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) } : files
        let workspace = shell.flatMap { PondsModel.shared.key(of: $0) }.flatMap { PondWorkspace(pond: $0) }
        let item = model.location.chatKey == nil ? nil : workspace.flatMap { model.tabStore.currentPondItem($0.project.id) }
        VStack(spacing: 0) {
            if let shell, newDuck, let workspace {
                // New layout: the one top bar is above (WorkbenchCentre); a Duck adds one subheader and the Pond-coloured gradient.
                DuckSubheader(session: shell, workspace: workspace).id(workspace.project.id)
            } else if let shell {
                WorkbenchHeader(
                    session: shell, project: place?.project.name ?? HomeProjects.projectName(shell), workspace: place?.workspace.displayTitle,
                    sidebarHidden: sidebarHidden, inspectorOpen: inspectorOpen, toggleSidebar: toggleSidebar)
                if let workspace {
                    let strip = workspace.strip(place: AppModel.duckRowPlace(shell), store: model.tabStore)
                    PondWorkspaceTabStrip(workspace: workspace, strip: strip).id(workspace.project.id)
                } else if let workspace = place?.workspace {
                    WorkbenchTabs(workspace: workspace, files: files, artifact: artifactChat != nil ? artifact : nil)
                }
            } else {
                HStack {
                    // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                    if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve) }
                    Spacer(minLength: 0)
                }
                .frame(height: Metrics.header).background(WindowDragArea())
            }
            ZStack {
                // The chat layer: kept mounted under a creation page (not when there is no chat to keep).
                if !showingCompose || bodyChat != nil {
                    chatBody(chat: bodyChat, files: bodyFiles, artifact: artifactChat != nil ? artifact : nil, newDuck: newDuck)
                        .workbenchLayer(hidden: showingCompose || item != nil)
                }
                if !showingCompose, let workspace, let item { PondItemPage(item: item, workspace: workspace) }
                if showingCompose { DesktopComposePage() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Pond tint (§3.5). A Duck page carries a visible gradient in the Pond's colour from behind the subheader, easing into the
        // chat ground over ~220pt; elsewhere the wash stays a very faint one over the header and the tab strip.
        .background(alignment: .top) {
            if newDuck && workspace != nil {
                DuckPondGradient(pond: PondColour.openPond(shell)).allowsHitTesting(false)
            } else {
                LinearGradient(colors: [PondColour.wash(PondColour.openPond(shell), .workbenchTop), .clear], startPoint: .top, endPoint: .bottom)
                    .frame(height: Metrics.header + Metrics.tabStrip).allowsHitTesting(false)
            }
        }
        // Another chat, workspace or the sidebar's pick brings the chat back over an open file.
        .onChange(of: model.lastChat) { _, key in
            for f in model.filesModels.values { f.showChat() }; DockStore.shared.deselectTerminals(.centre)
            if let d = DockStore.shared.ducklings.selected[.centre], d.session != key { DockStore.shared.deselectDucklings(.centre) }
        }
        .onChange(of: files?.activePath, initial: true) { _, _ in KeyFocus.shared.centre = Self.centre(files) }
        .onChange(of: files?.review.isOpen, initial: true) { _, _ in KeyFocus.shared.centre = Self.centre(files) }
        .modifier(FileCloseGuard(files: files))
        .modifier(TerminalDockSync(cwd: shell?.cwd))
        .modifier(PathToast(files: files))
        .modifier(ChatPathLinks(files: files, cwd: shell?.cwd))
        .onReceive(NotificationCenter.default.publisher(for: .squeakShowAllChanges)) { _ in if !focus.isPondPage { files?.showReview() } }
    }
}

extension WorkbenchCentre {
    /// What the centre shows for a chat (or the Dashboard, Usage and the empty states when there is none).
    @ViewBuilder fileprivate func chatBody(chat: HostSession?, files: FilesModel?, artifact: (pond: String, path: String)? = nil, newDuck: Bool = false) -> some View {
        if let artifact {
            ArtifactViewerPage(pond: artifact.pond, path: artifact.path, embedded: true).id(artifact.path)
        } else if let chat, let ref = DockStore.shared.ducklings.selected[.centre], ref.session == chat.key {
            DucklingPanel(session: chat, chip: model.ducklings(for: chat)?.items.first { $0.id == ref.taskId }, taskId: ref.taskId, centred: true)
                .id(ref.taskId)
        } else if newDuck {
            // The Pond strip owns the item selection in the new layout.
            DetailView()
        } else if let chat, let shell = DockStore.shared.activeTerminals.shown(in: .centre) {
            TerminalPanelView(session: chat, shell: shell)
        } else if let chat, let panel = DockStore.shared.layout.centre.selected {
            DockPanelContent(panel: panel, session: chat).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let files, let chat, files.review.isOpen {
            ReviewView(files: files, session: chat).heresayPrivate()
        } else if let files, let file = files.activeFile, DockStore.shared.files.zone(of: file.path) == .centre {
            FileViewer(files: files, file: file).id(file.path)
        } else {
            DetailView()
        }
    }
}

/// Whether the workbench layer is on screen. A layer covered by a page stays mounted (so its chat keeps its scroll and
/// state) but must not animate, poll or take keys: views with heavy tasks or repeating animations read this.
private struct WorkbenchVisibleKey: EnvironmentKey { static let defaultValue = true }
extension EnvironmentValues {
    var workbenchVisible: Bool {
        get { self[WorkbenchVisibleKey.self] }
        set { self[WorkbenchVisibleKey.self] = newValue }
    }
}

extension View {
    /// A layer under a page: invisible, inert, hidden from VoiceOver and told it is not visible. Focus leaves it, so
    /// nothing typed lands in a composer nobody can see.
    func workbenchLayer(hidden: Bool) -> some View {
        self
            .opacity(hidden ? 0 : 1)
            .allowsHitTesting(!hidden)
            .accessibilityHidden(hidden)
            .disabled(hidden)
            .environment(\.workbenchVisible, !hidden)
            .background(LayerFocusGuard(hidden: hidden))
    }
}

/// Takes keyboard focus out of the layer it sits behind when that layer is covered (only if focus is inside it).
private struct LayerFocusGuard: NSViewRepresentable {
    let hidden: Bool
    func makeNSView(context: Context) -> NSView { NSView() }
    func updateNSView(_ view: NSView, context: Context) {
        guard hidden else { return }
        DispatchQueue.main.async { [weak view] in
            guard let view, let window = view.window, let responder = window.firstResponder as? NSView,
                  let layer = view.superview, responder.isDescendant(of: layer) else { return }
            window.makeFirstResponder(nil)
        }
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
    let inspectorOpen: Bool
    let toggleSidebar: () -> Void
    @Environment(AppModel.self) private var model

    /// A Squeak stream reads by its title; any other chat by its branch, else its workspace.
    private var streamTitle: String? { session.workspaceTitle.flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : workspace } }
    private var branch: String? { session.branch.flatMap { $0.isEmpty ? nil : $0 } }
    /// The directory's pond for this chat (its name is the crumb); Other chats keep the fleet's folder name and no page.
    private var pondKey: String? { model.focus.pond ?? PondsModel.shared.key(of: session) }
    /// Ducks mode (the daemon's flag): the header is the duck's, not the stream's.
    private var ducks: Bool { model.ducksMode && session.source == .squeak && session.duckId != nil }
    private var duckChrome: DuckHeaderChrome {
        let row = model.duckRow(session)
        return DuckHeaderChrome.of(branch: model.gitStatus(session)?.branch ?? row.branch, isMain: row.isMain, membership: model.focus.access)
    }
    private var pondTitle: String { pondKey.map { PondsModel.shared.name(key: $0) } ?? project }

    var body: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve - Space.l) }
            repoIcon
            HStack(spacing: 8) {
                CrumbButton(title: pondTitle, label: PondWords.breadcrumb(pondTitle)) {
                    if let pondKey { WorkbenchNav.openProject(model, key: pondKey, resuming: false) }
                }
                if ducks {
                    // Ducks mode: pond › duck title, then the branch chip (the duck's own, or main · read-only).
                    Lucide(.chevronRight, size: 12, color: Theme.subtle)
                    Text(verbatim: model.workbenchTitle(session)).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                    DuckBranchChip(chrome: duckChrome)
                } else if let crumb = streamTitle ?? branch ?? workspace {
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
            // The new layout's Duck has no Git cluster: review-all carries merge and the PR.
            if session.source == .squeak, model.focus.access.showsCode, !ducks || duckChrome.showsCreatePR,
               !WorkPaneActions.isDuckView(session) { GitCluster(session: session, showsBranch: false) }
            // The inspector's toggle (PaneToggleOverlay) sits here while the panel is closed.
            if !inspectorOpen { Color.clear.frame(width: PaneToggle.size) }
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }

    @ViewBuilder private var repoIcon: some View {
        if let icon = PondIcons.shared.icon(projectId: pondKey.flatMap { PondsModel.shared.entry($0)?.projectId }, name: pondTitle) {
            Image(nsImage: icon).resizable().scaledToFill().frame(width: 20, height: 20).clipShape(RoundedRectangle(cornerRadius: 20 * 0.28, style: .continuous))
        } else {
            Text(String(pondTitle.prefix(1)).uppercased()).font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 20, height: 20)
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
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 26, height: 26).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More").help("Copy the branch, reveal the folder")
    }

    /// The branch this one merges into, quietly, as the target's header shows it.
    @ViewBuilder private var targetBranch: some View {
        // Main has no stream, so no branch it merges into.
        if session.source == .squeak, !(ducks && !duckChrome.showsCreatePR), let status = model.gitStatus(session), !status.main, !status.base.isEmpty {
            let base = status.base
            Text(verbatim: "origin/\(base)").font(.system(size: 13)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: 170, alignment: .trailing).help("The branch this merges into")
        }
    }
}

/// "Open in ▾" (quiet): Open in Conductor for a Conductor chat, and the workspace actions Conductor chats have.
/// The items of "Open in": the classic header's menu and, in the new layout, the Duck's one ⋯ menu.
struct OpenInItems: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    static func isOffered(_ session: HostSession, model: AppModel) -> Bool {
        session.capabilities.openInHost.isSupported || (session.conductorSessionId != nil && model.workspaceRepos != nil)
    }

    private var canOpen: Bool { session.capabilities.openInHost.isSupported }
    private var hasActions: Bool { session.conductorSessionId != nil && model.workspaceRepos != nil }
    private var resting: Bool { session.state != .working && !(session.state == .blocked && session.pendingQuestion == nil) }

    var body: some View {
        if canOpen {
            Button("Open in \(model.openHostName ?? "app")") { model.openInHost() }
                .disabled(model.chatBusy || (model.openURL == nil && !model.demoMode))
        }
        if hasActions {
            if canOpen { Divider() }
            Button("Open a pull request") { Task { await model.askForPullRequest(session) } }.disabled(!resting || model.chatBusy)
            Divider()
            Button("Archive workspace…", role: .destructive) { Task { await model.archiveWorkspace(session) } }.disabled(!resting || model.chatBusy)
        }
    }
}

private struct OpenInMenu: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if OpenInItems.isOffered(session, model: model) {
            SqueakMenu {
                OpenInItems(session: session)
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
            .help("Open this chat in \(model.openHostName ?? "its app"), or workspace actions")
            .accessibilityLabel("Open in")
        }
    }
}

/// Workspace tabs hold their order across activity updates, workspace switches and relaunches.
private struct WorkbenchTabs: View {
    let workspace: SidebarWorkspace
    let files: FilesModel?
    /// The artifact tab on screen, when the centre shows one of this strip's.
    var artifact: (pond: String, path: String)?
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.workbenchVisible) private var visible
    @State private var showHistory = false

    private var dock: DockStore { DockStore.shared }
    /// The strip's threads: one docked in a side zone is not here (a thread is in one place).
    private var chats: [HostSession] { model.streamThreads(workspace).filter { !dock.threads.isDocked($0.key.stringValue) } }

    private enum StripItem: Identifiable {
        case chat(HostSession), file(OpenFile), duckling(DucklingRef), artifact(pond: String, path: String), placeholder
        var id: String {
            switch self {
            case .artifact(let pond, let path): "artifact-\(ArtifactTabID.make(pond: pond, path: path))"
            case .placeholder: "placeholder"
            case .duckling(let r): "duckling-\(r.session.stringValue)-\(r.taskId)"
            case .chat(let s): "chat-\(s.key.stringValue)"
            case .file(let f): "file-\(f.id.uuidString)"
            }
        }
    }

    /// Threads and files in the order they were opened (the saved strip); before the stream has one, threads then files.
    private var stripItems: [StripItem] {
        CentreStripOrder.order(baseItems, chatKey: { if case .chat(let s) = $0 { s.key.stringValue } else { nil } },
                               ducklings: dock.ducklings.ducklings(in: .centre))
            .map { e in switch e { case .item(let i): i; case .duckling(let r): .duckling(r) } }
    }

    /// What the strip shows for where the centre is (`StripPlan`): a New thread page is a selected placeholder.
    private var plan: StripPlan { StripPlan.plan(location: model.baseLocation, previous: model.lastChat?.stringValue, threads: chats.map { $0.key.stringValue }) }
    /// A New thread page is on screen: the placeholder is the selected tab, so nothing else reads as selected.
    private var composing: Bool { plan.selected == .placeholder && model.location.composePage == .newThread }
    /// The artifact tabs saved for this stream, after its chats and files.
    private var artifactTabs: [(pond: String, path: String)] { model.tabStore.tabs(model.tabPond(workspace)).compactMap { $0.kind == .artifact ? ArtifactTabID.parse($0.id) : nil } }

    /// The New chat placeholder, the one thing the strip shows that is not saved: it sits after the chat the transcript
    /// follows. Squeak adds no other tab; the open chat has its tab only when the person opened it.
    private func applyPlan(_ items: [StripItem]) -> [StripItem] {
        guard plan.entries.contains(.placeholder) else { return items }
        var out = items
        let after = out.firstIndex { if case .chat(let s) = $0 { s.key == model.lastChat } else { false } }
        out.insert(.placeholder, at: after.map { $0 + 1 } ?? out.endIndex)
        return out
    }

    private var baseItems: [StripItem] { applyPlan(savedItems) }

    /// The Pond's saved tabs as the store has them, unfiltered and unreordered: a Duck as its newest chat, a file where it
    /// is open, a canvas. A thing the list does not carry yet simply is not drawn (it stays saved).
    private var savedItems: [StripItem] {
        let open = files?.open.filter { !$0.isListing } ?? []
        let byPath = Dictionary(open.map { ($0.path, $0) }, uniquingKeysWith: { a, _ in a })
        let pond = model.tabPond(workspace)
        var out: [StripItem] = []
        for t in model.tabStore.tabs(pond) {
            switch t.kind {
            case .duck: if let s = model.chat(for: t), !dock.threads.isDocked(s.key.stringValue) { out.append(.chat(s)) }
            case .file: if let f = byPath[t.id] { out.append(.file(f)) }
            case .artifact: if let a = ArtifactTabID.parse(t.id) { out.append(.artifact(pond: a.pond, path: a.path)) }
            case .duckling, .diff, .reviewAll, .notebook: break
            }
        }
        // A listing tab is not saved: it sits at the end.
        out += (files?.open ?? []).filter(\.isListing).map(StripItem.file)
        return out
    }

    /// The saved tabs as drawn, left to right: what a drop or a keyboard move is decided among (ducklings, panels and
    /// shells are not in it).
    private var streamOrder: [TabItem] {
        stripItems.compactMap { item in
            switch item {
            case .chat(let s): .of(s)
            case .file(let f): dock.files.zone(of: f.path) == .centre ? .file(f.path) : nil
            case .artifact(let pond, let path): .artifact(pond: pond, path: path)
            case .duckling, .placeholder: nil
            }
        }
    }

    private var streamContext: CentreStreamContext { CentreStreamContext(workspace: workspace, order: streamOrder) }

    private var fileShowing: Bool { files?.activePath != nil || files?.review.isOpen == true }

    @State private var stripWidth: Double = 0
    @State private var capMemo = TabCapMemo()
    @State private var hoveredTab: SessionKey?
    @Namespace private var tabIndicator
    /// The widest any tab may be: infinity while every tab fits at its natural width (see `ChatTabWidth.cap`).
    private var tabCap: CGFloat {
        var titles = chats.map { model.workbenchTitle($0) }
        titles += (files?.open ?? []).filter { dock.files.zone(of: $0.path) == .centre }.map(\.name)
        titles += dock.ducklings.ducklings(in: .centre).map { r in model.session(r.session).flatMap { model.ducklings(for: $0)?.items.first { $0.id == r.taskId }?.title } ?? "Duckling" }
        titles += artifactTabs.map { ArtifactViewerPage.item(pond: $0.pond, path: $0.path, remote: ArtifactViewerPage.isRemote(pond: $0.pond)).name }
        titles += dock.layout.centre.panels.filter { $0 != .terminal }.map(\.title)
        titles += dockTerminalTabs(in: .centre, session: chats.first)?.tabs.map { TerminalHost.shared.tabTitle(of: $0) } ?? []
        // Measuring is the cost: once per (titles, width bucket), not once per body.
        return CGFloat(capMemo.value(titles: titles, width: stripWidth) {
            Double(TabTitleMeasure.cap(titles: titles, available: stripWidth - 120))
        })
    }

    var body: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(stripItems) { item in
                        switch item {
                        case .chat(let s): tab(s).transition(.opacity)
                        case .placeholder: placeholderTab.transition(.opacity)
                        case .artifact(let pond, let path): artifactTab(pond: pond, path: path)
                        case .duckling(let ref):
                            if let parent = model.session(ref.session) {
                                DockDucklingTab(session: parent, ref: ref, zone: .centre, selected: !composing && dock.ducklings.selected[.centre] == ref,
                                                height: Metrics.tabStrip, indicator: tabIndicator).transition(.opacity)
                            }
                        case .file(let f):
                            if let files, dock.files.zone(of: f.path) == .centre {
                                DockFileTab(files: files, file: f, zone: .centre, selected: !composing && artifact == nil && files.activePath == f.path && dock.layout.centre.selected == nil && dock.ducklings.selected[.centre] == nil,
                                            height: Metrics.tabStrip, indicator: tabIndicator,
                                            preview: model.tabStore.isPreview(.file(f.path), in: model.tabPond(workspace)),
                                            pin: { model.pinTab(.file(f.path), in: workspace) }) {
                                    dock.deselectTerminals(.centre); dock.deselectDucklings(.centre)
                                    dock.update { $0.selectChats() }
                                    model.leaveArtifact()
                                    files.activePath = f.path
                                }
                            }
                        }
                    }
                    ForEach(dock.layout.centre.panels.filter { $0 != .terminal }, id: \.self) { p in
                        DockPanelTab(panel: p, zone: .centre, selected: !composing && dock.layout.centre.selected == p, height: Metrics.tabStrip, indicator: tabIndicator) {
                            files?.showChat()
                            dock.deselectTerminals(.centre); dock.deselectDucklings(.centre)
                            model.leaveArtifact()
                            dock.update { $0.select(p) }
                        }
                    }
                    if let shells = dockTerminalTabs(in: .centre, session: chats.first) {
                        ForEach(shells.tabs) { t in
                            DockTerminalTab(tab: t, folder: shells.folder, zone: .centre, selected: !composing && dock.activeTerminals.shown(in: .centre) == t.id, height: Metrics.tabStrip, indicator: tabIndicator)
                        }
                    }
                    Button {
                        if case .newTerminal = DockPlusAction.of(zone: .centre, layout: dock.layout, terminals: dock.activeTerminals) {
                            NewTerminalAction.perform(model, in: .centre)
                        } else if workspace.isDucks, let pid = model.focus.pond.flatMap({ PondsModel.shared.entry($0)?.projectId }) ?? chats.first.flatMap({ model.duckPondKey($0) }).flatMap({ PondsModel.shared.entry($0)?.projectId }) {
                            // Ducks mode: a new duck in the pond; the daemon decides where it works.
                            // Opened from a duck's chat: the new chat works with that duck's branch.
                            let current = chats.first(where: { $0.key == model.focus.chat }) ?? chats.first
                            model.openNewMainThread(projectId: pid, duckPlace: current.flatMap { DuckList.plusPlace(for: $0, main: model.mainPlace(key: model.duckPondKey($0) ?? "")) })
                        } else if let native = model.nativeWorkspace(of: workspace) {
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
                    .accessibilityLabel("New duck").shortcutHint(text: ShortcutFocus.newThreadHint(in: KeyFocus.shared.region, terminalOpen: KeyFocus.shared.terminalOpen), name: "New duck")
                }
                .environment(\.tabMaxWidth, tabCap)
                .environment(\.centreStream, streamContext)
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
        .dockDrop(.centre, wash: false)
        .onGeometryChange(for: Double.self) { Double($0.size.width) } action: { stripWidth = $0 }
        // File tabs are saved with the strip: brought back once per run, if the file is still there.
        .task(id: files?.root) {
            guard let files, !files.restoredTabs else { return }
            let saved = model.tabStore.fileTabs(model.tabPond(workspace))
            let gone = saved.filter { !files.fileExists($0) }
            model.forgetFileTabs(gone, in: workspace)
            let selected = model.tabStore.current(model.tabPond(workspace))
            let active = selected.flatMap { $0.kind == .file ? $0.id : nil }
            await files.restoreTabs(saved.filter { !gone.contains($0) }, active: active)
        }
        .onChange(of: files?.open.filter { !$0.isListing }.map(\.path) ?? []) { old, new in
            guard files?.restoredTabs == true else { return }
            for p in new where !old.contains(p) { model.fileTabOpened(p, in: workspace, files: files) }
            for p in old where !new.contains(p) { model.fileTabClosed(p, in: workspace) }
        }
        .onChange(of: files?.pinRequest) { _, req in
            if let req { model.pinTab(.file(req.path), in: workspace) }
        }
        .modifier(CentreFileDockSync(files: files))
        .modifier(ArtifactLeaveSync(files: files))
        .onChange(of: files?.activePath) { _, path in if let path, files?.restoredTabs == true { model.fileTabSelected(path, in: workspace) } }
        .onReceive(NotificationCenter.default.publisher(for: .squeakCloseTab)) { note in
            guard visible else { return }
            let box = note.object as? CloseTabAction.Box
            if let artifact { model.closeArtifactTab(pond: artifact.pond, path: artifact.path, in: workspace); box?.handled = true }
            else if let files, files.review.isOpen { files.closeReview(); box?.handled = true }
            else if let files, let path = files.activePath { files.close(path); box?.handled = true }
            else if let s = chats.first(where: { $0.key == model.lastChat }), ChatTabs.canClose(shown: chats.count) { closeTab(s); box?.handled = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: .squeakMoveTab)) { note in
            if visible { moveShownTab(by: (note.object as? Int) ?? 1) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .squeakStepTab)) { note in
            guard visible else { return }
            let delta = (note.object as? Int) ?? 1
            let shown = chats
            let current = files?.activePath == nil && files?.review.isOpen != true ? model.focus.chat : nil
            if let next = ChatTabs.step(from: current, in: shown.map(\.key), by: delta) { files?.showChat(); model.select(next) }
        }
        // A chat opened some other way (the sidebar, a notification) is no longer in the closed memory (it opened its own tab).
        .onChange(of: model.lastChat) { _, key in dock.update { $0.selectChats() }; if let key { WorkbenchPrefs.shared.forgetClosed(key, in: workspace.id) } }
        .animation(Motion.standard, value: ChatTabs.token(chats.lazy.map { $0.key.stringValue }))
        .animation(Motion.standard, value: model.lastChat)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func artifactTab(pond: String, path: String) -> some View {
        let tab = TabItem.artifact(pond: pond, path: path)
        return ArtifactStripTab(pond: pond, path: path, selected: artifact?.pond == pond && artifact?.path == path,
                                height: Metrics.tabStrip, indicator: tabIndicator, preview: model.tabStore.isPreview(tab, in: model.tabPond(workspace)),
                                pin: { model.pinTab(tab, in: workspace) }, open: { model.openArtifact(pond: pond, path: path) },
                                close: { model.closeArtifactTab(pond: pond, path: path, in: workspace) })
            .transition(.opacity)
    }

    /// The keyboard reorder: the tab on screen (a chat, file or canvas) moves one place along the strip.
    private func moveShownTab(by delta: Int) {
        guard !composing, dock.layout.centre.selected == nil, dock.ducklings.selected[.centre] == nil,
              dock.activeTerminals.shown(in: .centre) == nil else { return }
        var shown: TabItem?
        if let artifact { shown = .artifact(pond: artifact.pond, path: artifact.path) }
        else if let path = files?.activePath { shown = .file(path) }
        else if let chat = model.focus.chat.flatMap({ model.session($0) }) { shown = .of(chat) }
        guard let shown, let landing = TabDrop.step(in: streamOrder, tab: shown, by: delta) else { return }
        model.moveTab(shown, to: landing, workspace: workspace)
    }

    /// Hides the tab (the chat is untouched); closing the open one moves to the tab beside it. The last one leaves for
    /// the pond's overview page, or stays on a file tab open in the stream.
    /// Closing a tab only closes it: the duck keeps its duty.
    private func closeLabel(_ s: HostSession) -> String { "Close \(model.workbenchTitle(s))" }

    private func closeTab(_ s: HostSession) {
        let shown = chats
        guard ChatTabs.canClose(shown: shown.count) else { return }
        let wasOpen = s.key == model.lastChat
        // A tab opened from a pond (the room or the dashboard): when it was the last of them, closing it comes back there.
        var back: PondOriginStack.Origin?
        for r in dock.ducklings.ducklings(in: .centre) where r.session == s.key {
            dock.closeDuckling(r)
            back = back ?? PondOrigin.shared.closed(tab: PondOrigin.ducklingTab(r))
        }
        back = PondOrigin.shared.closed(tab: s.key.stringValue) ?? back
        WorkbenchPrefs.shared.closeTab(s.key, in: workspace.id)
        let next = model.closeDuckTab(s, in: workspace)
        if let back, wasOpen { PondOrigin.shared.goBack(to: back); return }
        if shown.count == 1 {
            if ChatTabs.afterClosingLast(fileTabOpen: fileShowing) == .pondPage, let pond = PondsModel.shared.key(of: s) {
                WorkbenchNav.openProject(model, key: pond, resuming: false)
            }
            return
        }
        if wasOpen, let next { model.select(next) }
    }

    private func reopenTab() {
        if let key = WorkbenchPrefs.shared.reopenTab(in: workspace.id, available: workspace.chats.map(\.key)) {
            model.select(key)
        }
    }

    /// A working chat's tab leads with Squeak's matrix glyph; any other tab has no mark (no grip: tabs still drag).
    /// Completed unread is semibold.
    /// Just the agent's own logo (Claude's, Codex's), no badge; the duck only for an agent with no logo.
    @ViewBuilder private func tabIcon(_ s: HostSession) -> some View {
        if let m = s.agentMark { AgentMark(m, size: 16) }
        else { ThreadDuckView(id: s.key.stringValue, agent: s.agent, size: ThreadDuck.Size.tab) }
    }

    /// The New thread page, as the strip's selected tab: closing it (or Esc) returns to the chat that was open.
    private var placeholderTab: some View {
        StripTab(selected: true, height: Metrics.tabStrip, indicator: tabIndicator, closeLabel: "Close new chat",
                 titleWidth: TabTitleMeasure.width("New chat", semibold: false), close: { NewChatController.shared.hide() },
                 icon: { Lucide(.plus, size: 14, color: Theme.muted) },
                 title: { Text("New chat").font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1) })
            .accessibilityLabel("New chat").accessibilityAddTraits([.isButton, .isSelected])
    }

    /// The Conductor source marker remains, but status dots and spinners do not accompany titles.
    private func tab(_ s: HostSession) -> some View {
        let selected = !composing && artifact == nil && model.focus.chat == s.key && files?.activePath == nil && files?.review.isOpen != true && dock.layout.centre.selected == nil && dock.ducklings.selected[.centre] == nil
        let running = s.state == .working
        let mark = selected || running ? nil : model.mark(for: s)
        let open = { files?.showChat(); dock.deselectTerminals(.centre); dock.deselectDucklings(.centre); dock.update { $0.selectChats() }; model.select(s.key) }
        return Group {
            StripTab(selected: selected, height: Metrics.tabStrip, indicator: tabIndicator, closeLabel: closeLabel(s),
                     showsClose: !chats.isEmpty,
                     titleWidth: model.isRenaming(s) ? 160 : TabTitleMeasure.width(model.workbenchTitle(s), semibold: model.isUnread(s)),
                     titleExtra: s.showsConductorBadge ? 18 : 0, activity: TabSlotContent.activity(of: model.mark(for: s)?.kind),
                     onHover: { inside in
                         hoveredTab = inside ? s.key : (hoveredTab == s.key ? nil : hoveredTab)
                         if inside { dock.hoveredTab = .thread(s.key.stringValue) } else if dock.hoveredTab == .thread(s.key.stringValue) { dock.hoveredTab = nil }
                     }, close: { closeTab(s) },
                     // Which agent runs the chat, in Squeak's own marks (§3.3), before the title.
                     icon: { tabIcon(s).help(SessionText.agentName(s.agent) ?? "") },
                     title: {
                         HStack(spacing: 4) {
                             if model.isRenaming(s) {
                                 InlineTitleEditor(session: s, font: Typo.body)
                             } else {
                                 Text(verbatim: model.workbenchTitle(s)).font(Typo.body.weight(model.isUnread(s) ? .semibold : .regular))
                                     .foregroundStyle(selected || model.isUnread(s) ? Theme.ink : Theme.muted).lineLimit(1).truncationMode(.tail)
                             }
                             if s.showsConductorBadge { ConductorMarker().fixedSize() }
                         }
                     })
        }
        // Not a Button: a Button takes the mouse-down and the drag never starts.
        .onTapGesture { if !model.isRenaming(s) { open() } }
        .accessibilityAddTraits(.isButton)
        .opacity(dock.dragging == .thread(s.key.stringValue) ? 0.35 : 1)
        .animation(Motion.quick, value: dock.dragging == .thread(s.key.stringValue))
        .onDrag { dragProvider(DockItemPayload.encode(.thread(s.key.stringValue)), kind: .thread) } preview: { DockTabDragPreview(title: model.workbenchTitle(s)) }
        .modifier(CentreTabDrop(tab: .of(s)))
        .accessibilityLabel(SessionText.accessibility(title: model.workbenchTitle(s), mark: mark, last: s.lastActivityAt)
                            + (running ? ", Running" : ""))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(model.workbenchTitle(s))
        .squeakContextMenu {
            RenameThreadItem(session: s)
            DuckMenuItems(session: s)
            Divider()
            Button("Close tab") { closeTab(s) }
            Button("Reopen closed tab") { reopenTab() }.disabled(!WorkbenchPrefs.shared.closed.hasClosed(in: workspace.id))
        }
    }
}


/// Keeps file placements honest: a file opened (say from the Files list) that sits in another zone is shown there, not
/// in the centre, and placements of files that are no longer open (closed anywhere) are dropped.
private struct CentreFileDockSync: ViewModifier {
    let files: FilesModel?
    @Environment(AppModel.self) private var model

    private var openPaths: Set<String> { Set(model.filesModels.values.flatMap { $0.open.map(\.path) }) }

    func body(content: Content) -> some View {
        content
            .onChange(of: files?.review.isOpen) { _, open in if open == true { DockStore.shared.update { $0.selectChats() } } }
            .onChange(of: files?.activePath) { _, path in
                let dock = DockStore.shared
                if path != nil { dock.update { $0.selectChats() } }
                if let path, dock.files.zone(of: path) != .centre { dock.selectFile(path); files?.showChat() }
            }
            .onChange(of: openPaths, initial: true) { _, open in DockStore.shared.pruneFiles(keeping: open) }
    }
}


/// Keeps the dock's placement of this folder's shells in step with the host's registry (new shells to the home zone,
/// ended ones dropped).
private struct TerminalDockSync: ViewModifier {
    let cwd: String?
    private let host = TerminalHost.shared
    private struct SyncInput: Equatable { var folder: String?; var ids: [UUID] }

    func body(content: Content) -> some View {
        let folder = TerminalWorkspace.availability(cwd: cwd).folder
        let ids = folder.map { host.registry.tabs($0).map(\.id) } ?? []
        // The folder counts too: a workspace switch with the same shells (or none) moves `activeFolder` in the same step.
        content.onChange(of: SyncInput(folder: folder, ids: ids), initial: true) { _, input in
            if let folder = input.folder { DockStore.shared.syncTerminals(folder: folder, live: input.ids) }
        }
    }
}


/// An artifact open as a tab of the chat strip: its file-type icon and name, closable.
private struct ArtifactStripTab: View {
    let pond: String
    let path: String
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    var preview = false
    var pin: () -> Void = {}
    let open: () -> Void
    let close: () -> Void

    var body: some View {
        let item = ArtifactViewerPage.item(pond: pond, path: path, remote: ArtifactViewerPage.isRemote(pond: pond))
        let tab = TabItem.artifact(pond: pond, path: path)
        StripTab(selected: selected, height: height, indicator: indicator, closeLabel: "Close \(item.name)",
                 titleWidth: TabTitleMeasure.width(item.name, semibold: false), close: close,
                 icon: { Lucide(item.kind.lucide, size: 13, color: selected ? Theme.ink : Theme.muted) },
                 title: {
                     Text(verbatim: item.name).font(Typo.body).italic(preview).foregroundStyle(selected ? Theme.ink : Theme.muted)
                         .lineLimit(1).truncationMode(.middle)
                 })
            .contentShape(Rectangle())
            .onTapGesture(perform: open)
            .simultaneousGesture(TapGesture(count: 2).onEnded { if preview { pin() } })
            .opacity(DockStore.shared.draggingArtifact == tab ? 0.35 : 1)
            .animation(Motion.quick, value: DockStore.shared.draggingArtifact == tab)
            .onDrag {
                DockStore.shared.draggingArtifact = tab
                return dragProvider(ArtifactDragPayload.encode(pond: pond, path: path), kind: .artifact)
            } preview: { DockTabDragPreview(title: item.name) }
            .modifier(CentreTabDrop(tab: tab))
            .squeakContextMenu {
                if preview { Button("Keep open", action: pin) }
                Button("Close tab", action: close)
            }
            .accessibilityElement(children: .combine).accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            .accessibilityLabel(item.name).help(item.name)
    }
}


/// A chat or canvas tab in the centre strip takes drops on its halves: before it on the left, after it on the right.
private struct CentreTabDrop: ViewModifier {
    let tab: TabItem
    @Environment(AppModel.self) private var model
    @Environment(\.centreStream) private var centre

    @ViewBuilder func body(content: Content) -> some View {
        if let centre {
            content.modifier(TabReorderDrop(target: .centreStrip, item: tab, order: centre.order, dragged: centre.dragged) { text, landing in
                performCentreStreamDrop(text, landing: landing, in: centre, model: model)
            })
        } else { content }
    }
}

/// Any other tab becoming the shown one (a file, a panel, a shell, a duckling) takes the centre from an open artifact.
private struct ArtifactLeaveSync: ViewModifier {
    let files: FilesModel?
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        let dock = DockStore.shared
        content
            .onChange(of: files?.activePath) { _, path in if path != nil { model.leaveArtifact() } }
            .onChange(of: files?.review.isOpen) { _, open in if open == true { model.leaveArtifact() } }
            .onChange(of: dock.layout.centre.selected) { _, p in if p != nil { model.leaveArtifact() } }
            .onChange(of: dock.ducklings.selected[.centre]) { _, d in if d != nil { model.leaveArtifact() } }
            .onChange(of: dock.activeTerminals.shown(in: .centre)) { _, t in if t != nil { model.leaveArtifact() } }
    }
}
