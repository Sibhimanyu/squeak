import AppKit
import SqueakIcons
import SqueakMacCore
import Heresay
import SwiftUI

// Project navigation only: brand and project actions above a two-level project/worktree tree.
// Chats belong to the workspace tab strip, never this sidebar.
// Every list is newest first and the tree is `SidebarTreeBuilder`'s (SqueakMacCore): this file only draws.

/// What the project list and its icons are read again for: cheap revisions, never a rebuilt list of names.
private struct ProjectListID: Equatable { var sessions: Int; var projects: Int; var addons: Set<String> }

struct WorkbenchSidebar: View {
    /// The pane's drawn width (the window owns it: remembered, clamped, dragged).
    var width: CGFloat = Metrics.workbenchSidebar
    @Environment(AppModel.self) private var model
    @State private var showConnection = false
    /// "Other sessions" (terminal and headless agents in folders that are not projects) starts folded.
    @AppStorage("sidebarOtherOpen") private var otherOpen = false
    /// The Ponds list's label filter and whether hidden ponds show (kept across launches).
    @AppStorage("sidebarPondLabel") private var pondLabel = ""
    @AppStorage("sidebarShowHiddenPonds") private var showHiddenPonds = false
    /// Ducks mode: the ponds whose ducks are grouped by branch (JSON list of pond keys; `DuckGroupPrefs`).
    @AppStorage("sidebarDucksByBranch") private var groupedPonds = "[]"
    /// All, Shared (out or with me) or Not shared (`PondSharing.Scope` raw value).
    @AppStorage("sidebarPondScope") private var pondScope = PondSharing.Scope.all.rawValue
    private var scope: PondSharing.Scope { PondSharing.Scope.restore(pondScope) }
    /// The pond whose Labels popover is open (its project id).
    @State private var labelsFor: String?
    /// The pond a drag is over: an insertion line shows above it ("" = after the last pond).
    /// The pond being dragged, and the slot (0...count) where a gap is open for it. Both clear on drop and on cancel.
    @State private var draggingPond: String?
    /// The joined pond whose "Leave pond…" confirmation is open (its directory key).
    @State private var leaveFor: String?
    @State private var dropSlot: Int?
    private var order: PondOrderStore { PondOrderStore.shared }
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
        withAnimation(Motion.standard) {
            if model.demoMode { demoFolded = set } else { foldedRaw = set.sorted().joined(separator: "\n") }
        }
    }

    var body: some View {
        @Bindable var model = model
        @Bindable var git = model.git
        let tree = model.sidebarTree
        let sections = model.pondSections
        VStack(alignment: .leading, spacing: 0) {
            topBar
            macRow
            VStack(alignment: .leading, spacing: 0) {
                SidebarNavRow(icon: .layoutDashboard, title: "Dashboard", selected: model.focus.page == .home) { goHome() }
                createRow
                SidebarNavRow(icon: .search, title: "Search", selected: false) { NotificationCenter.default.post(name: .squeakOpenPalette, object: nil) }
            }
            .padding(.horizontal, Space.s).padding(.top, 4).padding(.bottom, 10)
            Rectangle().fill(Theme.line).frame(height: 1)
            PondsHeader(labels: PondFilter.counts(pondEntries), label: $pondLabel, showHidden: $showHiddenPonds, scope: $pondScope, order: orderMode) { mode in
                saveOrder(mode: mode, order: mode == .manual && (PondsModel.shared.directory?.order.ids.isEmpty ?? true) ? pondEntries.map(\.id) : nil)
            }
            Color.clear.frame(height: 0)
                .onReceive(NotificationCenter.default.publisher(for: .squeakMovePond)) { note in
                    if let name = PondsModel.shared.homeProject, let delta = note.object as? Int { stepPond(name, by: delta) }
                }
            if !pondLabel.isEmpty { PondFilterChip(label: pondLabel) { pondLabel = "" } }
            PondScopePicker(scope: Binding(get: { scope }, set: { pondScope = $0.rawValue }))
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if model.pondsLoading {
                        Text("Loading ponds\u{2026}").font(Typo.meta).foregroundStyle(Theme.muted)
                            .padding(.horizontal, Space.s).padding(.vertical, Space.s)
                    } else if !model.hasPonds {
                        Button { model.openNewPond() } label: {
                            Text("No ponds yet. New pond (\u{2318}N) makes one.").font(Typo.meta).foregroundStyle(Theme.muted)
                                .multilineTextAlignment(.leading).padding(.horizontal, Space.s).padding(.vertical, Space.s)
                        }.buttonStyle(.plain)
                    }
                    waitingPonds
                    projects(sections)
                    otherSessions(sections.otherSessions)
                }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        // Never narrower than the minimum, whatever the caller passes: pond names must always show (DESIGN.md §8.10).
        .frame(width: max(width, CGFloat(PaneWidths.sidebarRange.lowerBound)))
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground(edge: false))
        .overlay(alignment: .trailing) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea().allowsHitTesting(false) }
        // The polling loops (live steps, projects, workspaces, ponds) belong to the app (`AppModel.startLoops`), not this view.
        .task(id: ProjectListID(sessions: model.sessionKeysRevision, projects: model.nativeProjectsRevision, addons: model.enabledAddons)) {
            await model.refreshNativeProjects()
            PondIcons.shared.setRepositoryIcons(await model.projectIcons())
        }
        .task(id: model.nativeProjectsRevision) {
            if !model.demoMode { await PondIcons.shared.sync(model.native.projects, host: model.nativeHost) }
        }
        .onChange(of: model.native.projects, initial: true) { _, projects in
            PondsModel.shared.projects = projects
            if model.demoMode { PondsModel.shared.useDemoDirectory(projects) }
        }
        // The directory is read again whenever a project or a native chat appears or goes: it says where each one sits.
        .task(id: model.directoryRevision) {
            if !model.demoMode { await PondsModel.shared.refreshDirectory() }
        }
        .pondSheets()
        .leavePondDialog($leaveFor)
        .diskCleanupSheet()
        .sheet(item: $git.logSheet) { SetupLogSheet(sheet: $0) }
    }

    /// A pond, by its directory key: the chat last open in it, else its home.
    private func openHome(_ key: String) { WorkbenchNav.openProject(model, key: key) }

    /// A pond's settings page in the centre.
    private func openSettings(_ key: String) {
        model.openSettings(.pond(key))
    }

    // MARK: Tree

    /// The directory's ponds in its order (newest first, or the person's own), hidden ones flagged. Nothing is sorted or
    /// matched here.
    private var pondEntries: [PondFilter.Entry] {
        // Your order shows at once from the saved state; the directory's own order follows when it is read again.
        let ponds = PondsModel.shared.directory?.ponds ?? []
        let keys = PondOrder.apply(keys: ponds.map(\.id), state: order.state)
        let byId = Dictionary(ponds.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return keys.compactMap { byId[$0] }.map { d in
            PondFilter.Entry(id: d.id, name: d.name, hidden: d.hidden, labels: d.labels, shared: PondSharing.isShared(PondsModel.shared.pond(key: d.id)))
        }
    }

    private var orderMode: PondOrderMode { PondsModel.shared.directory?.order.mode ?? order.state.mode }

    /// Saves the mode and/or the id order (directory ids), then reads the directory again for the host's order.
    private func saveOrder(mode: PondOrderMode? = nil, order next: [String]? = nil) {
        order.set(mode: mode, order: next, host: model.demoMode ? nil : model.nativeHost) { await PondsModel.shared.refreshDirectory() }
    }

    private func endPondDrag() {
        withAnimation(Motion.standard) { draggingPond = nil; dropSlot = nil }
    }

    /// A drag has no cancel callback, so the dim and the gap are released when the button comes up outside a drop.
    private func watchPondDrag() {
        Task { @MainActor in
            while draggingPond != nil, NSEvent.pressedMouseButtons & 1 != 0 { try? await Task.sleep(nanoseconds: 80_000_000) }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if draggingPond != nil { endPondDrag() }
        }
    }

    /// The pond row's drag preview: its tile and name on a raised surface.
    private func pondDragPreview(name: String, pondId: String?) -> some View {
        HStack(spacing: Space.s) {
            PondTile(name: name, pondId: pondId, size: 20)
            Text(verbatim: name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
        }
        .padding(.horizontal, Space.m).frame(height: 34)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surfaceRaised))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
        .shadow(color: .black.opacity(0.28), radius: 10, y: 4)
        .padding(8)
    }

    /// A pond was dropped before `before` (nil: after the last shown): save the new order and switch to Your order.
    private func dropPond(_ moving: String, before: String?, shown: [String]) {
        let all = pondEntries.map(\.id)
        endPondDrag()
        guard let next = PondOrder.dropped(state: order.state, all: all, shown: shown, moving: moving, before: before) else { return }
        withAnimation(Motion.standard) { saveOrder(mode: .manual, order: next.order) }
    }

    /// Move a pond one place (the open pond, or the one right-clicked): saves the order and switches to Your order.
    private func stepPond(_ key: String, by delta: Int) {
        let all = pondEntries.map(\.id)
        let shown = PondFilter.apply(pondEntries, label: pondLabel, showHidden: showHiddenPonds, scope: scope).ids
        guard let next = PondOrder.stepped(all: all, shown: shown, moving: key, by: delta) else { return }
        withAnimation(Motion.standard) { saveOrder(mode: .manual, order: next) }
    }

    /// Hide or label a pond: keyed by the directory id (the project's id; a joined pond's own).
    private func savePrefs(_ key: String, hidden: Bool? = nil, labels: [String]? = nil) {
        guard !model.demoMode else { return }
        Task {
            try? await model.nativeHost.setProjectPrefs(key: key, hidden: hidden, labels: labels)
            await model.refreshNativeProjects()
            await PondsModel.shared.refreshDirectory()
        }
    }

    // MARK: Home, new branch, row keys

    private func goHome() { WorkbenchNav.goHome(model) }

    // Navigation lives in the window overlay so hiding this pane preserves its history.
    private var topBar: some View {
        Color.clear.frame(height: MacLayoutPreference.shared.isNew ? CGFloat(PondBarMetrics.height) : Metrics.header).background(WindowDragArea())
    }


    /// "<name>'s Mac" with a chevron, the duck as its small avatar: connection, usage and Settings behind it.
    @State private var macHovering = false
    private var macRow: some View {
        SqueakMenu {
            ForEach(Array(macMenuItems.enumerated()), id: \.offset) { _, item in macMenuItem(item) }
        } label: {
            HStack(spacing: 10) {
                DuckMark(width: 24)
                Text(verbatim: Self.macName).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Lucide(.chevronDown, size: 12, color: Theme.muted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s + 4).frame(height: 40).contentShape(Rectangle())
            .sidebarRowWash(selected: false, hovering: macHovering)
        }
        .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain)
        .onHover { macHovering = $0 }
        .pointerHand()
        .padding(.horizontal, Space.s)
        .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
        .onChange(of: daemonHealthy) { _, healthy in if healthy { showConnection = false } }
        .task { await model.account.refresh() }
        .accessibilityLabel("\(Self.macName): account, usage and settings")
    }

    /// Not loaded yet counts as healthy, so the warning never flashes at launch.
    private var daemonHealthy: Bool { !model.homeLoaded || model.isConnected }

    private var macMenuItems: [MacSwitcherMenu.Item] {
        MacSwitcherMenu.items(signedInEmail: model.account.email, cloudAvailable: model.account.canSignIn, daemonHealthy: daemonHealthy)
    }

    @ViewBuilder private func macMenuItem(_ item: MacSwitcherMenu.Item) -> some View {
        switch item {
        case .account(let email, let initial):
            Button { model.openSettings(.account) } label: {
                if let photo = model.account.avatar {
                    Label { Text(email) } icon: { Image(nsImage: AccountAvatar.menuImage(photo)) }
                } else {
                    Label(email, systemImage: "\(initial.lowercased()).circle.fill")
                }
            }
        case .signIn:
            Button("Sign in to Squeak…") { model.account.openSignIn(from: PondsModel.shared.homeProject.map(SignInOrigin.pond) ?? .dashboard) }
        case .signInInSettings:
            Button("Sign in…") { model.openSettings(.account) }
        case .serviceDown:
            Button { showConnection = true } label: { Label(MacSwitcherMenu.serviceDownTitle, systemImage: "exclamationmark.triangle") }
            Button("Restart") { model.daemon.repair(); model.recheck() }
            Divider()
        case .usage:
            Button("Usage") { model.location = .usage }
        case .divider: Divider()
        case .settings: Button("Settings…") { model.openSettings() }
        }
    }

    private static var macName: String {
        let first = PondsModel.shared.myName.split(separator: " ").first.map(String.init) ?? ""
        return first.isEmpty || first.contains("@") ? "This Mac" : "\(first)'s Mac"
    }

    /// Create: a page in the centre (start work, add a project, join a pond), selected like the Dashboard.
    private var createRow: some View {
        SidebarNavRow(icon: .plus, title: "Create", selected: model.focus.page == .compose(.newPond)) {
            model.openNewPond()
        }
        .help(PondWords.createTooltip)
    }

    /// A pond's status at a glance, from every thread in its streams (the daemon's rollup, same precedence).
    private func pondRollup(_ workspaces: [SidebarWorkspace]) -> StatusRollup {
        let chats = workspaces.flatMap(\.chats).map { model.withHostBackground($0) }
        return StatusRollup.of(marks: chats.map { model.mark(for: $0) }, ducklingsRunning: chats.map { $0.helpersKeepWorking ? 1 : 0 })
    }

    /// The workspace's open chat's diff, when Squeak has read it (the Changes store of a chat already visited): no
    /// polling for rows nobody looks at.
    private func diffStat(_ workspace: SidebarWorkspace) -> (added: Int, removed: Int)? {
        guard let chat = workspace.chats.first(where: { $0.key == model.focus.chat }) ?? workspace.chats.first,
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
        if let open = model.focus.chat, workspace.chats.contains(where: { $0.key == open }) {
            model.select(open)
        } else if let chat = workspace.chats.first {
            // A click opens exactly that one tab.
            WorkbenchPrefs.shared.forgetClosed(chat.key, in: workspace.id)
            model.select(chat.key)
        }
    }

    /// Joins waiting on an owner (greyed) and ones the owner declined; opening one shows its waiting card.
    @ViewBuilder private var waitingPonds: some View {
        ForEach(PondJoinWaiting.rows(PondsModel.shared.ponds).filter { PondsModel.shared.directory?.pond(pondId: $0.id) == nil }) { pond in
            Button { model.openPondHome(PondsModel.shared.key(forPond: pond)) } label: {
                HStack(spacing: Space.s) {
                    PondTile(name: pond.name, pondId: pond.id, size: 20)
                    Text(verbatim: PondJoinWaiting.rowTitle(pond)).font(Typo.label).foregroundStyle(Theme.muted)
                        .lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, Space.s).frame(minHeight: 30).contentShape(Rectangle())
                .opacity(0.7)
            }
            .buttonStyle(.plain).pointerHand()
            .accessibilityLabel(PondJoinWaiting.rowTitle(pond))
            .help(PondSidebar.tooltip(pond) ?? "")
        }
    }

    /// The pond's "+": a thread in its most recently used stream, Main when that is newest or there is no stream.
    private func addToPond(_ p: NativeProject, workspaces: [SidebarWorkspace], empty: [NativeWorkspace]) {
        var c = workspaces.map { w in
            PondAddTarget.Candidate(isMain: w.isMain, workspaceId: w.isMain ? nil : model.nativeWorkspace(of: w)?.id, lastActivityAt: w.lastActivityAt)
        }
        c += empty.map { PondAddTarget.Candidate(isMain: false, workspaceId: $0.id, lastActivityAt: nil) }
        switch PondAddTarget.choose(c) {
        case .main: model.openNewMainThread(projectId: p.id)
        case .stream(let id): model.openNewThread(projectId: p.id, workspaceId: id)
        }
    }

    @ViewBuilder private func projects(_ sections: SidebarSections) -> some View {
        let filtered = PondFilter.apply(pondEntries, label: pondLabel, showHidden: showHiddenPonds, scope: scope)
        let names = filtered.ids
        let gapSlot = draggingPond.flatMap { m in dropSlot.flatMap { PondDragTarget.gap(slot: $0, moving: m, shown: names) } }
        ForEach(Array(names.enumerated()), id: \.element) { index, key in
            let entry = PondsModel.shared.entry(key)
            let name = entry?.name ?? ""
            let native = PondsModel.shared.native(key: key)
            let workspaces = sections.workspaces(of: key)
            let pondRecord = PondsModel.shared.pond(key: key)
            let emptyWorkspaces = model.git.workspaces.filter { w in
                w.projectId == native?.id && w.state != "archived" && !workspaces.contains { ws in ws.chats.contains { $0.cwd == w.path } }
            }
            let projectFolded = folded.contains(key)
            let listed = model.ducksMode ? model.duckRows(pond: key).count : MainSidebar.streams(workspaces).count + emptyWorkspaces.count + (model.mainPlace(key: key) != nil ? 1 : 0)
            FoldRow(
                title: name, depth: 0, glyph: String(name.prefix(1)).uppercased(), icon: PondIcons.shared.icon(projectId: entry?.projectId, name: name),
                unread: ReadGate.anyUnread(workspaces.flatMap(\.chats)) { model.isUnread($0) },
                // The yellow badge is the Dashboard's "For you" list, from the same function.
                unreadCount: model.forYou(pond: key).count,
                adding: native.map { model.native.makingWorkspaceIn == $0.id } ?? false,
                // The count shows only when the rows are folded away or there are none to show.
                count: (projectFolded || listed == 0) ? PondRowCount.of(ducksMode: model.ducksMode, counts: model.ducksMode ? PondsModel.shared.directory?.pond(id: key)?.dutyCounts : nil, treeChats: sections.chatCount(of: key), listed: listed) : nil,
                // The row opens the pond's home and the chevron folds its threads.
                onAdd: model.ducksMode ? native.map { p in { model.openNewMainThread(projectId: p.id) } } : native.flatMap { p in p.isPlainFolder ? nil : { addToPond(p, workspaces: workspaces, empty: emptyWorkspaces) } },
                addHelp: model.ducksMode ? "New duck in \(name)" : "New duck in \(name)\u{2019}s latest stream", dimmed: entry?.hidden == true,
                inFocus: model.focus.pond == key,
                needs: PondsModel.shared.badge(pondRecord),
                rollup: pondRollup(workspaces),
                needsItems: model.needsYouItems(workspaces.flatMap(\.chats)),
                onNeeds: { model.openNeedsYou(pond: key, items: model.needsYouItems(workspaces.flatMap(\.chats))) },
                onDisclose: { toggleFold(key) },
                folded: projectFolded,
                badge: PondsModel.shared.chrome(key: key).badge,
                pondId: pondRecord?.id, projectId: entry?.projectId
            ) { openHome(key) }
            // Ducks mode: the row's number is the host's on-duty count (the directory's `dutyCounts`, from the same roster function).
            .padding(.top, 6 + (gapSlot == index ? 22 : 0))
            .overlay(alignment: .top) {
                // The gap that opens where the pond will land, with its insertion line.
                if gapSlot == index { Capsule().fill(PondColour.accent).frame(height: 2).padding(.horizontal, 6).padding(.top, 10).transition(.opacity) }
            }
            .opacity(draggingPond == key ? 0.35 : 1)
            .onDrag {
                draggingPond = key
                watchPondDrag()
                return dragProvider(PondDragPayload.encode(key), kind: .pond)
            } preview: { pondDragPreview(name: name, pondId: pondRecord?.id) }
            .onDrop(of: DragScope.types(for: .pondList), delegate: PondDropDelegate(
                slot: { y in PondDragTarget.slot(rowIndex: index, y: y - 6, rowHeight: 28) },
                over: { slot in if dropSlot != slot { withAnimation(Motion.standard) { dropSlot = slot } } },
                left: { withAnimation(Motion.standard) { dropSlot = nil } },
                perform: { slot in
                    guard let moving = draggingPond else { return false }
                    dropPond(moving, before: PondDragTarget.before(slot: slot, shown: names), shown: names)
                    return true
                }))
            .popover(isPresented: Binding(get: { labelsFor == key }, set: { if !$0 { labelsFor = nil } }), arrowEdge: .trailing) {
                PondLabelsPopover(name: name, current: entry?.labels ?? [], known: PondFilter.counts(pondEntries).map(\.label)) { savePrefs(key, labels: $0) }
            }
            .squeakContextMenu {
                Button("Move up") { stepPond(key, by: -1) }
                Button("Move down") { stepPond(key, by: 1) }
                Divider()
                if let native {
                    if model.ducksMode {
                        Button("New duck") { model.openNewMainThread(projectId: native.id) }.keyboardShortcut("n", modifiers: [.command, .shift])
                        if PondsModel.shared.chrome(key: key).showsBranchAndPR {
                            Button(DuckGroupPrefs.contains(groupedPonds, pond: key) ? "Ungroup ducks" : "Group by branch") {
                                groupedPonds = DuckGroupPrefs.toggled(groupedPonds, pond: key)
                            }
                        }
                        Divider()
                    } else if FolderPond.showsGitControls(native) {
                        Button("New duck in Main") { model.openNewMainThread(projectId: native.id) }
                        Button("New stream…") { model.openNewBranch(projectId: native.id, source: .newFromDefault) }.keyboardShortcut("n", modifiers: [.command, .shift])
                        Button("Open stream from branch…") { model.openNewBranch(projectId: native.id, source: .openBranch) }
                        Button("Open pull request…") { model.openNewBranch(projectId: native.id, source: .openPullRequest) }
                        Button("New stream for issue…") { model.openNewBranch(projectId: native.id, source: .forIssue) }
                        Divider()
                    }
                    Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: native.rootPath)]) }
                    Button("Labels…") { labelsFor = key }
                    Button(entry?.hidden == true ? "Unhide pond" : "Hide pond") { savePrefs(key, hidden: !(entry?.hidden == true)) }
                    Button("Pond settings…") { openSettings(key) }
                    Button("Clean up disk…") { DiskCleanupCenter.shared.open(pondId: native.id, pondName: name) }
                    if PondsModel.shared.chrome(key: key).showsLeave { Button("Leave pond…") { leaveFor = key } }
                } else if entry != nil {
                    // A joined pond has no folder here: it can be labelled, hidden and opened, with its own id as the key.
                    Button("Labels…") { labelsFor = key }
                    Button(entry?.hidden == true ? "Unhide pond" : "Hide pond") { savePrefs(key, hidden: !(entry?.hidden == true)) }
                    Button("Pond settings…") { openSettings(key) }
                    if PondsModel.shared.chrome(key: key).showsLeave { Button("Leave pond…") { leaveFor = key } }
                }
            }
            if !projectFolded && model.ducksMode {
                // Ducks mode: the pond's ducks directly, newest first, each with its branch; no stream rows.
                duckRows(of: key)
                sharedThreads(of: key)
            } else if !projectFolded {
                // Main, the pond's own folder, is listed only while it has a live thread; a Main chat has no stream (so no stream menu).
                if let mainRow = MainSidebar.row(main: model.mainPlace(key: key), in: workspaces), let native {
                    FoldRow(title: mainRow.displayTitle, depth: 1,
                        help: "Main: the pond\u{2019}s own folder, \(model.mainPlace(key: key)?.rootPath ?? "")",
                        selected: model.focus.workspace == mainRow.id,
                        running: mainRow.chats.contains { SessionGrouping.kind(of: model.withHostBackground($0), now: Date()) == .working || model.withHostBackground($0).isActive },
                        unread: mainRow.chats.contains { model.isUnread($0) },
                        streamState: .of(chats: mainRow.chats.map { model.withHostBackground($0) }, mark: { model.mark(for: $0) }),
                        conductor: false,
                        diff: diffStat(mainRow),
                        onAdd: { model.openNewMainThread(projectId: native.id) },
                        addHelp: "New duck in Main",
                        onKey: { key in rowKey(key, mainRow) }) {
                        if mainRow.chats.isEmpty { model.openNewMainThread(projectId: native.id) } else { openWorkspace(mainRow) }
                    }
                    .transition(Motion.fold)
                    .squeakContextMenu {
                        Button("New duck in Main") { model.openNewMainThread(projectId: native.id) }
                        if !mainRow.chats.isEmpty {
                            Button(mainRow.chats.contains { model.isUnread($0) } ? "Mark as read" : "Mark as unread") { toggleRead(mainRow) }
                        }
                    }
                }
                ForEach(WorkspaceNavigation.pinnedFirst(MainSidebar.streams(workspaces), pins: prefs.pins.ids)) { workspace in
                    let nativeWorkspace = model.nativeWorkspace(of: workspace)
                    let run = nativeWorkspace.flatMap { model.git.runs[$0.id] }
                    // The row is the stream, named as everywhere else (`StreamName`); chat titles live on the chat tabs.
                    FoldRow(title: workspace.displayTitle, depth: 1,
                        help: [workspace.displayTitle, workspace.branchLabel].compactMap { $0 }.joined(separator: " · "),
                        selected: model.focus.workspace == workspace.id,
                        running: workspace.chats.contains { SessionGrouping.kind(of: model.withHostBackground($0), now: Date()) == .working || model.withHostBackground($0).isActive },
                        unread: workspace.chats.contains { model.isUnread($0) },
                        streamState: .of(chats: workspace.chats.map { model.withHostBackground($0) }, mark: { model.mark(for: $0) }),
                        lifecycle: nativeWorkspace.flatMap { WorkspaceLifecycle.mark($0.state) },
                        runPort: run?.running == true ? (run?.port ?? nativeWorkspace?.port) : nil,
                        pinned: prefs.pins.contains(workspace.id),
                        conductor: workspace.chats.contains { $0.showsConductorBadge },
                        diff: diffStat(workspace),
                        onAdd: nativeWorkspace.map { w in { model.openNewThread(projectId: w.projectId, workspaceId: w.id) } },
                        addHelp: "New duck in \(workspace.displayTitle)",
                        onKey: { key in rowKey(key, workspace) }) {
                        openWorkspace(workspace)
                    }
                    .transition(Motion.fold)
                    .squeakContextMenu {
                        Button(prefs.pins.contains(workspace.id) ? "Unpin" : "Pin to top") { prefs.togglePin(workspace.id) }
                        Button(workspace.chats.contains { model.isUnread($0) } ? "Mark as read" : "Mark as unread") { toggleRead(workspace) }
                        if nativeWorkspace != nil { Divider() }
                        if let nativeWorkspace { WorkspaceMenu(workspace: nativeWorkspace) }
                    }
                }
                ForEach(emptyWorkspaces) { workspace in
                    FoldRow(title: workspace.displayTitle, depth: 1,
                        help: [workspace.displayTitle, workspace.branch].filter { !$0.isEmpty }.joined(separator: " · "),
                        lifecycle: WorkspaceLifecycle.mark(workspace.state),
                        onAdd: { model.openNewThread(projectId: workspace.projectId, workspaceId: workspace.id) },
                        addHelp: "New duck in \(workspace.displayTitle)") {
                        NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: workspace.projectId, workspaceId: workspace.id))
                    }
                    .transition(Motion.fold)
                    .squeakContextMenu { WorkspaceMenu(workspace: workspace) }
                }
                sharedThreads(of: key)
            }
        }
        // Dropping below the last pond puts it last.
        if names.count > 1 {
            Color.clear.frame(height: 10 + (gapSlot == names.count ? 22 : 0))
                .overlay(alignment: .top) { if gapSlot == names.count { Capsule().fill(PondColour.accent).frame(height: 2).padding(.horizontal, 6).padding(.top, 4) } }
                .onDrop(of: DragScope.types(for: .pondList), delegate: PondDropDelegate(
                    slot: { _ in names.count },
                    over: { slot in if dropSlot != slot { withAnimation(Motion.standard) { dropSlot = slot } } },
                    left: { withAnimation(Motion.standard) { dropSlot = nil } },
                    perform: { slot in
                        guard let moving = draggingPond else { return false }
                        dropPond(moving, before: nil, shown: names)
                        return true
                    }))
        }
        if filtered.hiddenCount > 0 || (showHiddenPonds && pondEntries.contains { $0.hidden }) {
            Button { showHiddenPonds.toggle() } label: {
                Text(showHiddenPonds ? "Hide hidden ponds" : "\(filtered.hiddenCount) hidden").font(Typo.meta).foregroundStyle(Theme.subtle)
                    .padding(.horizontal, Space.s + 2).frame(height: 28, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.top, 4)
            .accessibilityLabel(showHiddenPonds ? "Stop showing hidden ponds" : "\(filtered.hiddenCount) hidden ponds, show them")
        }
        if names.isEmpty && sections.otherSessions.isEmpty {
            Text(PondWords.openPondFirst).font(Typo.body).foregroundStyle(Theme.subtle).padding(Space.s)
        }
    }

    /// Ducks mode: a pond's ducks, newest first (one row each, its branch as a small mono label), or grouped by branch.
    @ViewBuilder private func duckRows(of key: String) -> some View {
        let rows = model.duckRows(pond: key)
        let showsBranch = PondsModel.shared.chrome(key: key).showsBranchAndPR
        if showsBranch, DuckGroupPrefs.contains(groupedPonds, pond: key) {
            ForEach(DuckList.groups(rows)) { g in
                Text(verbatim: g.isMain ? DuckRow.mainLabel : (g.label.isEmpty ? "no branch" : g.label)).font(Typo.code).foregroundStyle(Theme.subtle)
                    .lineLimit(1).truncationMode(.middle).padding(.leading, Space.s + 16).padding(.top, 6).frame(maxWidth: .infinity, alignment: .leading)
                ForEach(g.rows) { r in WorkbenchChatRow(session: r.session, indent: 1).transition(Motion.fold) }
            }
        } else {
            ForEach(rows) { r in WorkbenchChatRow(session: r.session, indent: 1, branch: showsBranch ? r.label : nil).transition(Motion.fold) }
        }
    }

    /// Threads other people started in this pond (shared with me, or a member's in my own pond): rows like my chats' with the
    /// starter's small avatar, newest first. A row opens the thread in the workbench (`PondThreadView`).
    @ViewBuilder private func sharedThreads(of pond: String) -> some View {
        if let detail = PondsModel.shared.detail(key: pond) {
            let openId: String? = { if case .pondThread(_, let id, let thread) = model.location, id == detail.pond.id { return thread } else { return nil } }()
            ForEach(SharedThreadRows.rows(detail, keeping: openId, hidden: PondsModel.shared.hides.hiddenIds)) { row in
                SharedThreadRowView(row: row, project: pond, selected: openId == row.threadId).transition(Motion.fold)
            }
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
                ForEach(sessions) { WorkbenchChatRow(session: $0, indent: 1).heresayPrivate() }
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
    /// How many chats in the pond are unread (the new layout's count badge).
    var unreadCount = 0
    /// A stream's waves state (depth 1), derived from its chats; `.idle` when not given.
    var streamState: StreamGlyphState = .idle
    var adding = false
    /// A project row's worktree count, quiet and tabular after its name.
    var count: Int?
    /// A native workspace still setting up (the quiet loader) or whose setup failed (the failed mark), in the stat's slot.
    var lifecycle: WorkspaceLifecycle.Mark?
    /// The port of a running run script, a quiet mono tag.
    var runPort: Int?
    var pinned = false
    /// Conductor holds this workspace: its mark sits after the name.
    var conductor = false
    /// The workspace's lines added and removed, when read.
    var diff: (added: Int, removed: Int)?
    /// The "+": always visible on a pond row (new branch), on hover on a branch row (new thread); nil where there is none.
    var onAdd: (() -> Void)?
    var addHelp = ""
    /// A hidden pond shown on request.
    var dimmed = false
    /// Ponds: this project's home is open; what in it waits on you; the chevron that folds the threads; whether folded.
    var inFocus = false
    var needs = 0
    /// A pond row's status rollup (working / needs you / error), drawn in the count's slot; nil = the count as before.
    var rollup: StatusRollup?
    /// The chats the one rule names (waiting or a failure not yet seen): the mark's tooltip says which, and a click opens the one
    /// chat, or the pond's Needs-you list when there are several.
    var needsItems: [NeedsYouItem] = []
    var onNeeds: (() -> Void)?
    var onDisclose: (() -> Void)?
    var folded = false
    /// A small quiet label after a pond's name ("Remote": ducks on someone else's Mac).
    var badge: String?
    /// The pond behind a project row: its icon sits on the pond's tint.
    var pondId: String?
    /// The pond's project: its icon sits on the tile.
    var projectId: String?
    /// P and R while the row has focus (pin, read or unread).
    var onKey: ((Character) -> Void)?
    let action: () -> Void
    @State private var hovering = false
    @FocusState private var focused: Bool

    /// The count's slot, 24pt wide for the glyphs so a row never changes size: needs-you badge wins, then the working
    /// glyph, then the error mark; idle (or no rollup) is the count.
    private var newLayout: Bool { MacLayoutPreference.shared.isNew }
    private var newMarkSet: PondRowMarks { PondRowMarks.of(needsYou: max(needs, rollup?.needsYou ?? 0), unread: unreadCount) }
    private var hasNewMarks: Bool { newMarkSet.needsYou || newMarkSet.badge != nil }

    /// New layout: the amber triangle when something waits on you, and a duck-yellow badge with the unread count.
    @ViewBuilder private var newMarks: some View {
        let m = newMarkSet
        if m.needsYou { StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16).help("Waiting on you") }
        if let text = m.badgeText {
            Text(verbatim: text).font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(Color(nsColor: NSColor(hex: Tokens.duckOutline)))
                .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18).background(Theme.duck, in: Capsule())
                .help("\(text) unread").accessibilityLabel("\(text) unread")
        }
    }

    /// The pond's waiting or failed mark as a control: hover says which chats and why; a click goes to them (one chat opens, several
    /// open the pond's Needs-you list). With nothing to open (a count from another Mac) it is only the mark.
    @ViewBuilder private func markButton<M: View>(_ mark: M, fallback: String) -> some View {
        let help = needsItems.isEmpty ? fallback : PondNeedsYou.help(needsItems)
        if onNeeds != nil, !needsItems.isEmpty {
            Button { onNeeds?() } label: { mark.frame(width: 24, height: 24, alignment: .trailing).contentShape(Rectangle()) }
                .buttonStyle(.plain).pointerHand().help(help).accessibilityLabel(help)
                .accessibilityHint(PondNeedsYou.target(needsItems) == .list ? "Opens the pond's Needs you list" : "Opens the chat")
        } else {
            mark.frame(width: 24, alignment: .trailing).help(help).accessibilityLabel(help)
        }
    }

    @ViewBuilder private var pondMark: some View {
        let own = rollup ?? StatusRollup(state: needs > 0 ? .waiting : .idle, needsYou: needs)
        // An open pond shows its chats, and the working one moves: the pond itself does not repeat it.
        let r = StatusRollup(state: own.state.asRollup(childrenVisible: !folded), working: own.working, needsYou: own.needsYou)
        switch PondRowMark.of(r, count: count) {
        case .needsYou(let n):
            markButton(StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16), fallback: "\(needs > 0 ? needs : n) waiting on you")
        case .working:
            // 15 pt tall compact mark centred in a 24 pt slot: its visible pixels (about 23 pt) stay inside the slot, clear of the name.
            WorkingGlyph(slot: 24, alignment: .center, grid: .compact).padding(.leading, 6)
        case .error:
            markButton(StatusMark(kind: .failed, color: Theme.negative, size: 13), fallback: "A chat failed")
        case .count(let n):
            // New layout: the one number on a Pond row is the yellow "For you" badge; a grey count would mean something else.
            if !newLayout { Text("\(n)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle) }
        case nil:
            EmptyView()
        }
    }

        var body: some View {
        ZStack(alignment: .trailing) { row; HStack(spacing: 0) { disclosure; plus } }
            .onHover { hovering = $0 }
            .modifier(RowKeys(onKey: onKey, focused: $focused))
            .heresayPrivate()
    }

    @ViewBuilder private var disclosure: some View {
        if depth == 0, let onDisclose {
            Button(action: onDisclose) {
                HoverIcon(folded ? .chevronRight : .chevronDown, size: 12, rowHovering: hovering).frame(width: 38, height: 38).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(folded ? "Show ducks" : "Hide ducks")
            .accessibilityLabel(folded ? "Show \(title)'s ducks" : "Hide \(title)'s ducks")
        }
    }

    @ViewBuilder private var plus: some View {
        if let onAdd, depth == 0 || hovering {
            Button(action: onAdd) {
                Group {
                    if adding { TideGlyph(color: Theme.muted, grid: .mini) } else { HoverIcon(.plus, size: 16, rowHovering: hovering) }
                }
                .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(adding)
            .padding(.trailing, 6)
            .help(addHelp)
            .accessibilityLabel(addHelp)
        }
    }

    private var rowContent: some View {
            HStack(spacing: 10) {
                if depth == 0 {
                    Group {
                    if let icon {
                        // An image icon fills exactly the letter tile (26 pt, radius 7), never on the pond tint.
                        Image(nsImage: icon).resizable().scaledToFill().frame(width: 26, height: 26)
                            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .padding(-3).frame(width: 20, height: 20)
                    } else if newLayout, pondId != nil {
                        // New layout (DESIGN.md 8.12): the pond's own colour as a 26 pt tile carrying its initial (an image icon
                        // above still fills the same tile). The initial reads against the accent (`bg`), or `ink` on the soft tint.
                        let accented = pondId.map { PondsModel.shared.accentSeed(forPondId: $0) != nil } ?? false
                        Text(glyph ?? "").font(.system(size: 14, weight: .bold)).foregroundStyle(accented ? Theme.bg : Theme.ink)
                            .frame(width: 26, height: 26)
                            .background(PondColour.pondAccent(pondId), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .padding(-3).frame(width: 20, height: 20)
                    } else {
                        // A letter sits on the pond's own soft tint; a project that is not a pond stays plain.
                        Text(glyph ?? "").font(.system(size: 15, weight: .bold)).foregroundStyle(Theme.ink).frame(width: 20, height: 20)
                            .padding(pondId == nil ? 0 : 3)
                            .background(pondId == nil ? .clear : PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            .padding(pondId == nil ? 0 : -3)
                    }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        // A pond someone shared with this person wears the sharer on its icon's corner.
                        if let badge = PondSharing.badge(for: PondsModel.shared.ponds.first { $0.id == pondId }) {
                            SharedPondBadge(badge: badge, size: 14).offset(x: 6, y: 6)
                        }
                    }
                } else {
                    StreamStateMark(state: streamState, slotWidth: 20)
                }
                Text(verbatim: title).font(.system(size: 14, weight: unread ? .semibold : .regular))
                    .foregroundStyle(depth == 0 || selected || unread ? Theme.ink : Theme.muted).lineLimit(1)
                    .truncationMode(.tail)
                if depth == 0, let badge { Text(verbatim: badge).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).fixedSize() }
                // An open pond shows its chats, each with its own mark: the rollup would only repeat them.
                if depth == 0, newLayout { newMarks }
                if depth == 0, folded || count != nil, !(newLayout && hasNewMarks) { pondMark }
                if conductor { ConductorMarker(size: 12) }
                if pinned { Lucide(.pin, size: 11, color: Theme.subtle).accessibilityLabel("Pinned") }
                Spacer(minLength: 0)
                if depth == 1, !(hovering && onAdd != nil) { trailing }
            }
            .padding(.leading, depth == 0 ? 10 : 22).padding(.trailing, depth == 0 ? (onDisclose != nil ? 78 : 40) : 10)
            .frame(height: depth == 0 ? 38 : 36)
            .sidebarRowWash(selected: selected || inFocus, hovering: hovering)
            .background(inFocus ? PondColour.wash(pondId, .pondHeader) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(alignment: .leading) {
                // The selected pond's accent: duck (dark) or duck-text (light), a short bar at the row's edge.
                if inFocus { Capsule().fill(PondColour.pondAccent(pondId, fallback: PondColour.accent)).frame(width: 3, height: 18).padding(.leading, 2) }
            }
            .contentShape(Rectangle())
    }

    /// A pond row is not a Button: a Button (and a simultaneous double-tap gesture) takes the mouse-down, so the
    /// row's `.draggable` never began a drag. One tap gesture reads the click count instead: the first click opens
    /// the pond, a double-click folds or unfolds it like its chevron.
    @ViewBuilder private var rowBody: some View {
        if depth == 0 {
            rowContent
                .onTapGesture {
                    focused = true
                    if (NSApp.currentEvent?.clickCount ?? 1) >= 2 { onDisclose?() } else { action() }
                }
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { focused = true; action() }
        } else {
            Button(action: { focused = true; action() }) { rowContent }.buttonStyle(.plain)
        }
    }

    private var row: some View {
        rowBody
        .help(help ?? (depth == 0 ? "Open \(title)" : ""))
        .pointerHand()
        .accessibilityLabel(depth == 0 && rollup != nil && (rollup!.working > 0 || rollup!.needsYou > 0)
            ? rollup!.label(for: title) : [title, depth == 0 ? "pond" : "stream", depth == 0 ? (running ? "Working" : (unread ? "Finished, not opened yet" : nil)) : streamState.words].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .opacity(dimmed ? 0.5 : 1)
    }

    @ViewBuilder private var trailing: some View {
        if lifecycle == .setupFailed {
            LifecycleSlot(mark: .setupFailed)
        } else if lifecycle == .settingUp {
            WorkingGlyph(color: Theme.muted, slot: 28, alignment: .trailing).opacity(0.7).frame(height: 16).help(WorkspaceLifecycle.words(.settingUp))
        } else if let diff, diff.added + diff.removed > 0 {
            HStack(spacing: 5) {
                Text("+\(DiffStatFormat.abbreviate(diff.added))").foregroundStyle(Theme.success)
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
    /// Ducks mode: the duck's branch as a small mono label ("main" for main).
    var branch: String?
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var selected: Bool { model.focus.chat == session.key }

    var body: some View {
        let mark = model.mark(for: session)
        let loud = mark?.kind == .waiting || mark?.kind == .unread
        RowOrButton(editing: model.isRenaming(session), action: { model.select(session.key) }) {
            HStack(spacing: 6) {
                ThreadDuckView(id: session.key.stringValue, agent: session.agent, size: ThreadDuck.Size.sidebarRow)
                if model.isRenaming(session) {
                    InlineTitleEditor(session: session, font: loud ? Typo.label : Typo.body)
                } else {
                    Text(verbatim: model.workbenchTitle(session)).font(loud ? Typo.label : Typo.body)
                        .foregroundStyle(selected || loud ? Theme.ink : Theme.muted).lineLimit(1)
                }
                if session.showsConductorBadge { ConductorMarker() }
                Spacer(minLength: 0)
                if let branch {
                    Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.middle)
                        .frame(maxWidth: 84, alignment: .trailing).help(branch)
                }
                if let n = model.ducklings(for: session)?.running, n > 0 {
                    HStack(spacing: 2) {
                        DucklingView(parentId: session.key.stringValue, parentSize: ThreadDuck.Size.tab)
                        Text(verbatim: "\(n)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    }
                    .help("\(DucklingWords.count(n)) running").accessibilityLabel("\(DucklingWords.count(n)) running")
                }
                MarkSlot(mark: mark, age: session.lastActivityAt)
            }
            .padding(.leading, Space.s + CGFloat(indent) * 16).padding(.trailing, Space.s)
            .frame(height: Metrics.chatRow)
            .background(selected ? Theme.selected.opacity(0.75) : (hovering ? Theme.selected.opacity(0.4) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .background(selected ? PondColour.wash(PondsModel.shared.key(of: session), .selectedRow) : .clear, in: RoundedRectangle(cornerRadius: Radius.control)).animation(Motion.quick, value: hovering)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .simultaneousGesture(TapGesture(count: 2).onEnded { model.renameThread(session) })
        .help(snippet ?? "")
        .squeakContextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
            RenameThreadItem(session: session)
            DismissFailureItem(session: session)
            DuckMenuItems(session: session)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.rowAccessibility(session) + (branch.map { ", \($0)" } ?? ""))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A thread someone else started, in the sidebar: a chat row (the duck, the title, the state mark or age) with the
/// starter's small avatar before the mark. Opens in the workbench like any chat.
struct SharedThreadRowView: View {
    let row: SharedThreadRow
    let project: String
    let selected: Bool
    @State private var hovering = false

    var body: some View {
        let loud = row.mark?.kind == .waiting
        Button { AppModel.shared.openPond(.thread(project: project, pondId: row.pondId, threadId: row.threadId)) } label: {
            HStack(spacing: 6) {
                ThreadDuckView(id: "pond-\(row.id)", agent: row.agent, size: ThreadDuck.Size.sidebarRow)
                Text(verbatim: row.title).font(loud ? Typo.label : Typo.body)
                    .foregroundStyle(selected || loud ? Theme.ink : Theme.muted).lineLimit(1)
                Spacer(minLength: 0)
                PondAvatarDot(spec: row.avatar, size: 16)
                MarkSlot(mark: row.mark, age: row.lastActivityAt)
            }
            .padding(.leading, Space.s + 16).padding(.trailing, Space.s)
            .frame(height: Metrics.chatRow)
            .background(selected ? Theme.selected.opacity(0.75) : (hovering ? Theme.selected.opacity(0.4) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .background(selected ? PondColour.wash(row.pondId, .selectedRow) : .clear, in: RoundedRectangle(cornerRadius: Radius.control)).animation(Motion.quick, value: hovering)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(row.help)
        .squeakContextMenu {
            // Someone else's thread: this hides it from your view only, never from the person who started it.
            Button("Archive") { PondsModel.shared.hideShared(threadId: row.threadId, pondId: row.pondId, pondName: project, title: row.title, agent: row.agent) }
        }
        .heresayPrivate()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.title), \(ThreadOwnership.line(starterName: row.starterName, isMine: false) ?? ""), \(row.mark?.words ?? "")")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// A plain SF Symbol after a title, 14pt, in the muted colour, where Conductor holds the chat. Tooltip "Conductor chat".
struct ConductorMarker: View {
    var size: CGFloat = 14

    var body: some View {
        Image(systemName: "point.3.connected.trianglepath.dotted")
            .font(.system(size: size))
            .foregroundStyle(Theme.muted)
            .frame(width: size, height: size)
            .help("Conductor chat")
            .accessibilityLabel("Conductor chat")
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
    static func ask(title: String, message: String, placeholder: String, initial: String = "", confirm: String = "Continue", allowEmpty: Bool = false) -> String? {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: confirm)
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = placeholder
        field.stringValue = initial
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty && !allowEmpty ? nil : text
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

/// A section header of a sidebar list ("My branches", Settings' groups).
struct SidebarSectionHeader: View {
    let title: String
    var body: some View {
        Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
            .padding(.horizontal, Space.l).padding(.top, 14).padding(.bottom, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// The one sidebar row look, shared by ponds, the nav rows and the Mac switcher: the rounded wash when selected,
    /// half of it under the pointer. Pair with `.pointerHand()`.
    func sidebarRowWash(selected: Bool, hovering: Bool) -> some View {
        background(selected ? Theme.selected : (hovering ? Theme.selected.opacity(0.5) : .clear), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .animation(Motion.quick, value: hovering)
    }
}

struct SidebarNavRow<Icon: View>: View {
    let title: String
    var selected = false
    let action: () -> Void
    @ViewBuilder let icon: Icon
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            SidebarNavLabel(title: title) { icon }
                .sidebarRowWash(selected: selected, hovering: hovering)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .pointerHand()
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

extension SidebarNavRow where Icon == Lucide {
    init(icon: LucideName, title: String, selected: Bool = false, action: @escaping () -> Void) {
        self.init(title: title, selected: selected, action: action) { Lucide(icon, size: 17, color: Theme.muted) }
    }
}


/// A row's trailing icon: subtle at rest, muted while the row is hovered, ink under the pointer (DESIGN.md §8.10).
private struct HoverIcon: View {
    let name: LucideName
    let size: CGFloat
    let rowHovering: Bool
    @State private var over = false
    init(_ name: LucideName, size: CGFloat, rowHovering: Bool) { self.name = name; self.size = size; self.rowHovering = rowHovering }
    var body: some View {
        Lucide(name, size: size, color: over ? Theme.ink : (rowHovering ? Theme.muted : Theme.subtle))
            .animation(Motion.quick, value: over || rowHovering)
            .onHover { over = $0 }
    }
}

/// Tracks where a dragged pond hovers (before or after the row, by the pointer's half) and performs the drop.
private struct PondDropDelegate: DropDelegate {
    let slot: (Double) -> Int
    let over: (Int) -> Void
    let left: () -> Void
    let perform: (Int) -> Bool

    func dropEntered(info: DropInfo) { over(slot(info.location.y)) }
    func dropUpdated(info: DropInfo) -> DropProposal? { over(slot(info.location.y)); return DropProposal(operation: .move) }
    func dropExited(info: DropInfo) { left() }
    func performDrop(info: DropInfo) -> Bool { perform(slot(info.location.y)) }
}
