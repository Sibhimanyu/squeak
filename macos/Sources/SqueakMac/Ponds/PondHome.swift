import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond home: clicking a project in the sidebar opens it here, not a chat. The workspaces with
// their threads and participants form the main column; the flock and Ripples sit alongside it when space allows.
// Local ponds use the same hierarchy. Filtering and deduplicated counts live in SqueakMacCore (`PondHomeLayout.swift`).

/// Chooses what the centre shows for a pond route.
struct PondRouteView: View {
    let route: PondRoute
    let sidebarHidden: Bool
    /// The one top bar is drawn above by WorkbenchCentre; the Dashboard and Room draw only their pages.
    var barHosted = false
    @Environment(AppModel.self) private var model

    /// A pond opens on its Dashboard; the Room is the other page beside it (`PondSpace`), swapped by the switch or a
    /// two-finger swipe. A pond with no native project (or still waiting to join) has no room, so it keeps the dashboard.
    private func roomProject(_ key: String) -> (id: String, member: Bool)? { Self.roomProject(key) }

    static func roomProject(_ key: String) -> (id: String, member: Bool)? {
        if let waiting = PondsModel.shared.pond(key: key), PondStates.isGreyedRow(waiting) { return nil }
        // Someone else's pond: its Room is the Owner's, read through the cloud by the pond's id.
        if let pond = PondsModel.shared.pond(key: key), pond.role != .owner, !pond.id.isEmpty { return (pond.id, true) }
        return PondsModel.shared.native(key: key).map { ($0.id, false) }
    }

    private var sidebarClearance: CGFloat {
        sidebarHidden ? PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size : 0
    }

    /// The pond key the route is for; a loaded directory without it means the pond is gone.
    private var goneKey: String? {
        switch route {
        case .home(let p), .settings(let p), .thread(let p, _, _): PondsModel.shared.isGone(p) ? p : nil
        case .archived: nil
        }
    }

    var body: some View {
        if goneKey != nil {
            // Never an empty owner pond: the location is pruned to the Dashboard; nothing draws meanwhile.
            Color.clear.onAppear { AppModel.shared.prunePonds(live: PondsModel.shared.directory?.liveKeys) }
        } else if case .home(let project) = route, let room = roomProject(project) {
            let page = RoomViewPref.shared.mode(for: project)
            if let workspace = PondWorkspace(pond: project) {
                let strip = workspace.strip(place: PondPageChrome.rowPlace(page: page), store: model.tabStore)
                let inset = PondPageChrome.headerInset(sidebarClearance: Double(sidebarClearance))
                VStack(spacing: 0) {
                    if !barHosted {
                        PondSharedHeader(key: project, projectId: room.id, member: room.member, leadingInset: CGFloat(inset),
                                         itemShowing: strip.currentItem != nil, workspace: workspace, strip: strip)
                    }
                    ZStack {
                        PondSpace(key: project, projectId: room.id, member: room.member, leadingInset: CGFloat(inset), showsHeader: false) {
                            standard(header: false)
                        }
                        .workbenchLayer(hidden: strip.currentItem != nil)
                        if let item = strip.currentItem { PondItemPage(item: item, workspace: workspace) }
                    }
                }
            } else {
                PondSpace(key: project, projectId: room.id, member: room.member, leadingInset: sidebarClearance) { standard() }
            }
        } else {
            standard()
        }
    }

    /// The pond page's own header. With the new layout's Duck row above, the row carries the sidebar clearance.
    private func standard(clearance: CGFloat? = nil, header: Bool = true) -> some View {
        VStack(spacing: 0) {
            if header { HStack {
                // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                if sidebarHidden { Color.clear.frame(width: clearance ?? sidebarClearance) }
                Spacer(minLength: 0)
                if case .home(let project) = route {
                    if PondsModel.shared.native(key: project) != nil || roomProject(project) != nil { HStack(spacing: Space.m) { RoomModeSwitch(key: project); PondHeaderMenu(key: project) }.padding(.trailing, Space.xl) }
                    else if PondsModel.shared.chrome(key: project).showsLeave { PondHeaderMenu(key: project).padding(.trailing, Space.xl) }
                }
            }
            .frame(height: Metrics.header).background(WindowDragArea()) }
            switch route {
            case .home(let project):
                if let waiting = PondsModel.shared.pond(key: project), PondStates.isGreyedRow(waiting) {
                    ScrollView {
                        JoinWaitingCard(pond: waiting) { AppModel.shared.closePondPage() }
                            .frame(maxWidth: 520).padding(Space.xl).frame(maxWidth: .infinity, alignment: .top)
                    }.screen("Pond")
                } else {
                    PondHomeView(key: project).id(project).screen("Pond")
                }
            case .settings(let project): PondSettingsView(key: project).screen("Pond settings")
            case .archived: ArchivedPageView().screen("Archived")
            case .thread(let project, let pondId, let threadId):
                PondThreadView(key: project, pondId: pondId, threadId: threadId).id(threadId).screen("Duck")
            }
        }
    }
}

struct PondHomeView: View {
    /// The pond's directory key; `project` reads its name.
    let key: String
    private var project: String { ponds.name(key: key) }
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var scope: PondDashboardScope = .all
    @State private var archivedOpen = false
    /// Bumped when the next-steps card is dismissed, so the body reads the stored choice again.
    @State private var dismissTick = 0

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var native: NativeProject? { ponds.native(key: key) }
    private var roster: RoomRosterModel? { native.map { RoomRosterStore.shared.model(for: $0.id) } }
    private var localSessions: [HostSession] { model.pondProject(key).workspaces.flatMap(\.chats) }
    private var person: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }

    private var layout: PondHomeLayout {
        // Ducks mode: the host's roster is the one list of the Pond's Ducks; this Mac's chats only say what a click opens.
        if model.ducksMode, let roster {
            return PondHomeLayout.buildRoster(
                ducks: roster.list, sessions: localSessions, detail: detail, me: person, hostIdFor: { model.hostId($0) },
                hiddenThreads: ponds.hides.hiddenIds, ownThreads: ponds.ownThreads)
        }
        return PondHomeLayout.build(
            project: model.pondProject(key), detail: detail, me: person,
            emptyBranches: model.ducksMode ? [] : PondHomeLayout.emptyBranches(model.git.workspaces, projectId: native?.id, chats: localSessions),
            main: model.ducksMode ? nil : native.flatMap { MainPlace(project: $0) },
            hostIdFor: { model.hostId($0) }, titleFor: { model.workbenchTitle($0) }, markFor: { model.mark(for: $0) },
            hiddenThreads: ponds.hides.hiddenIds, ownThreads: ponds.ownThreads, offDutySessions: roster?.offDutySessions ?? [], offDutyNotes: roster?.offDutyNotes ?? [:])
    }

    /// The one-time "Next steps" card (`PondNextSteps`): gone for good once dismissed.
    @ViewBuilder private func nextSteps(_ layout: PondHomeLayout) -> some View {
        let _ = dismissTick
        let steps = PondNextSteps.steps(
            dismissed: PondOnce().done(.nextSteps, pond: key), canStartDuck: chrome.start != .hidden, hasDucks: !layout.isEmpty,
            canInvite: role.canInvite && pond != nil, memberCount: pond?.memberCount ?? 1,
            plainFolder: native?.isPlainFolder == true, isRemote: chrome.isRemote)
        if let steps {
            PondNextStepsCard(
                key: key, steps: steps, startDuck: { startThread() },
                invite: { if let pond { ponds.startInvite(pondId: pond.id, account: model.account) } },
                dismiss: { PondOnce().markDone(.nextSteps, pond: key); dismissTick += 1 })
        }
    }

    var body: some View {
        let layout = layout
        let joins = role.canApproveJoins ? (detail?.joins ?? []) : []
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    PondForYouCard(key: key)
                    nextSteps(layout)
                    overview(layout, compact: geometry.size.width < 650)
                    if !joins.isEmpty { joinsGroup(joins) }
                    presence
                    // The people, invites and pond controls live in the inspector beside this page (`PondInspector`).
                    threads(layout).frame(maxWidth: .infinity, alignment: .leading)
                    if let native, !chrome.isRemote { CanvasesSection(pondKey: key, projectId: native.id) }
                    if chrome.isRemote { RemoteCanvasesSection(pondKey: key) }
                    ripples
                }
                .padding(geometry.size.width < 600 ? 20 : 32)
                .frame(maxWidth: PondInspectorSections.dashboardContentWidth, alignment: .leading).frame(maxWidth: .infinity)
                .background(ScrollMemory(id: "pond:\(key):dashboard"))
            }
            .scrollIndicators(.hidden)   // no scroll bar riding along in the Dashboard/Room slide
        }
        .background(Theme.bg)
        .onAppear { ponds.note = nil }
        .pondHeartbeat(pond: pond?.id)
        .task(id: native?.id) { roster?.keepFresh(host: model.nativeHost) }
    }

    // MARK: Identity and overview

    private var header: some View {
        VStack(alignment: .leading, spacing: 20) {
            // The Pond's icon and name are in the top bar; the card keeps its label and its actions.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 20) {
                    overviewLabel
                    Spacer(minLength: 16)
                    actions
                }
                VStack(alignment: .leading, spacing: 20) {
                    overviewLabel
                    actions
                }
            }
            statusRow
        }
        .padding(24)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 2).fill(PondColour.pondAccent(pond?.id))
                .frame(width: 44, height: 4).padding(.leading, 24)
        }
    }

    /// The one status row of the dashboard: a fixed height whatever it says, so nothing below it ever moves. The access
    /// line (with the info mark when this Mac can only share threads into the pond), the latest note or result, and a
    /// small slot for refreshing / can't-reach that only fades.
    private var statusRow: some View {
        let status = ponds.headerStatus(pond, access: accessDescription)
        let message: (text: String, icon: String)? = ponds.note.map { ($0, "info.circle") }
            ?? pond.flatMap { ponds.result[$0.id] }.map { ($0, "checkmark.circle") }
        return HStack(spacing: 8) {
            Image(systemName: pond?.local ?? true ? "desktopcomputer" : "person.2").accessibilityHidden(true)
            Text(verbatim: status.accessLine).lineLimit(1).truncationMode(.tail)
            if let info = status.info {
                Image(systemName: "info.circle").help(info).accessibilityLabel(info)
            }
            Spacer(minLength: 8)
            if let message {
                Label(message.text, systemImage: message.icon).labelStyle(.titleAndIcon).lineLimit(1).truncationMode(.tail)
                    .help(message.text).transition(.opacity)
            }
            statusSlot(status.indicator)
        }
        .font(Typo.footnote).foregroundStyle(Theme.muted)
        .frame(height: 20)
        .animation(Motion.quick, value: message?.text)
    }

    /// A fixed 24 x 20 slot: its contents fade, its size never changes.
    private func statusSlot(_ indicator: PondHeaderIndicator) -> some View {
        ZStack {
            switch indicator {
            case .none: Color.clear
            case .refreshing: WorkingGlyph(slot: 20).transition(.opacity).accessibilityLabel("Refreshing")
            case .problem(let help):
                Lucide(.triangleAlert, size: 13, color: Theme.warning).help(help).accessibilityLabel(help)
            case .retry(let help):
                Button { if let id = pond?.id { ponds.retry(id) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless).help(help + " Try again").accessibilityLabel("Try again")
            }
        }
        .frame(width: 24, height: 20)
        .animation(Motion.quick, value: indicator)
    }

    private var overviewLabel: some View {
        Text("Pond overview").font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize().accessibilityAddTraits(.isHeader)
    }

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { inviteAction; startAction; settingsAction }
            VStack(alignment: .leading, spacing: 10) {
                startAction
                HStack(spacing: 8) { inviteAction; settingsAction }
            }
        }
    }

    @ViewBuilder private var inviteAction: some View {
        if role.canInvite, let p = pond {
            Button { ponds.startInvite(pondId: p.id, account: model.account) } label: { Text("Invite").lineLimit(1).fixedSize() }
                .buttonStyle(SecondaryButtonStyle()).disabled(!ponds.freshness(p).canWrite)
                .help(ponds.freshness(p).writesDisabledReason ?? "Invite someone to this pond")
        }
    }

    private var chrome: PondChrome { PondsModel.shared.chrome(key: key) }

    @ViewBuilder private var startAction: some View {
        if pond == nil || pond?.local == true || pond.map({ PondStartThread.offer(for: $0) }).map({ $0 != .none }) == true {
            let why: String? = pond.flatMap { p in
                if case .shareOnly(let w) = PondStartThread.offer(for: p), !p.local, !PondStartThread.runsOnOwnerMac(p) { return w } else { return nil }
            }
            switch chrome.start {
            case .hidden: EmptyView()
            case .own, .askOwner:
                let label: String = { if case .askOwner(let l) = chrome.start { return l } else { return "Start a duck" } }()
                Button { startThread() } label: { Label(label, systemImage: "plus").lineLimit(1).fixedSize() }
                    .buttonStyle(PondPrimaryButtonStyle())
                    .disabled(why != nil).help(why ?? (chrome.isRemote ? label : "Start a duck in this pond"))
            }
        }
    }

    /// Pond settings is in the header's ⋯ menu whenever that menu is there; the gear only stands in for it when it is not.
    @ViewBuilder private var settingsAction: some View {
        if !hasHeaderMenu { settingsButton }
    }

    /// The same test the page's header applies to show its ⋯ menu (a room, or a pond that can be left).
    private var hasHeaderMenu: Bool {
        if PondsModel.shared.native(key: key) != nil || PondsModel.shared.chrome(key: key).showsLeave { return true }
        guard let p = pond, !PondStates.isGreyedRow(p) else { return false }
        return p.role != .owner && !p.id.isEmpty
    }

    private var settingsButton: some View {
        Button { model.openSettings(.pond(key)) } label: {
            Lucide(.settings, size: 16, color: Theme.muted).frame(width: 32, height: 32).contentShape(Rectangle())
        }
        .buttonStyle(.borderless).help(PondWords.settings).accessibilityLabel(PondWords.settings)
    }

    private var accessDescription: String {
        if pond?.local ?? true { return PondStates.headerLine(pond) ?? PondWords.onlyThisMac }
        if let pond, case .shareOnly(let why) = PondStartThread.offer(for: pond) { return why }
        guard let pond else { return "" }
        // The host's own sentence for the role and the people, else what is plainly true.
        var parts = ["\(role.word) \u{00B7} \(pond.memberCount) \(pond.memberCount == 1 ? "person" : "people")"]
        if let owner = pond.ownerName, role != .owner { parts.append("owned by \(owner)") }
        if role == .viewer { parts.append(PondThreadStatus.viewerLine) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// Who is here, the Tasks waiting and the Notebook: what the Room's side panel shows, here because the Dashboard has no
    /// side panel. The Ducks working are the Working tile above and the list below, so they are not repeated.
    @ViewBuilder private var presence: some View {
        if let native, !chrome.isRemote {
            let panel = PondPresence.panel(key: key, projectId: native.id)
            VStack(alignment: .leading, spacing: 12) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        presenceCard { PondPeopleSection(panel: panel) }
                        presenceCard { PondTasksSection(panel: panel) }
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        presenceCard { PondPeopleSection(panel: panel) }
                        presenceCard { PondTasksSection(panel: panel) }
                    }
                }
                PondNotebookRow(key: key)
            }
        }
    }

    private func presenceCard<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        content().padding(16).frame(maxWidth: .infinity, alignment: .topLeading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
    }

    private func overview(_ layout: PondHomeLayout, compact: Bool) -> some View {
        let counts = roster?.counts ?? PondCounts.none
        return LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: compact ? 2 : 4), spacing: 12) {
            ForEach(PondDashboardScope.tiles, id: \.self) { item in
                let count = counts.count(item) + (item == .needsYou && role.canApproveJoins ? (detail?.joins.count ?? 0) : 0)
                Button { scope = scope == item ? .all : item } label: {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 6) {
                            if item == .needsYou {
                                Lucide(.triangleAlert, size: 13, color: count > 0 ? Theme.warning : Theme.muted)
                            } else if item == .working && count > 0 {
                                WorkingGlyph(slot: 20, alignment: .leading, grid: .compact)
                            }
                            Text(verbatim: item.title).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1).fixedSize(horizontal: true, vertical: false)
                        }
                        .frame(height: 16)  // the working glyph or the alert icon never makes one tile taller
                        Text(verbatim: "\(count)")
                            .font(.system(size: 28, weight: .medium)).monospacedDigit()
                            .foregroundStyle(item == .needsYou && count > 0 ? Theme.warning : Theme.ink)
                        // Every tile reserves the secondary line ("21 in all" on Off duty) so the four are one height.
                        let line = PondCounts.secondary(item, counts)
                        Text(verbatim: line ?? " ").font(Typo.meta).foregroundStyle(Theme.muted)
                            .opacity(line == nil ? 0 : 1).accessibilityHidden(line == nil)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    .background(scope == item ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(item.title), \(count) ducks")
                .accessibilityAddTraits(scope == item ? .isSelected : [])
                .help("Show \(item.title.lowercased())")
            }
        }
    }

    private func threads(_ layout: PondHomeLayout) -> some View {
        let filtered = layout.filtered(query: query, scope: scope)
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text(model.ducksMode ? "Ducks" : "Streams & ducks").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer()
                if let native, !chrome.isRemote, !model.ducksMode {
                    Button { model.nativeMakeWorkspace(projectId: native.id) } label: { Label("New stream", systemImage: "plus") }
                        .buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
                }
            }
            Text(model.ducksMode ? "Ducks work across the whole Pond and choose which Streams to join." : "Each stream is a separate working folder. Its ducks work with the same files.")
                .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
                TextField(model.ducksMode ? "Find a duck or person" : "Find a stream, duck or person", text: $query).textFieldStyle(.plain)
                    .font(Typo.body).accessibilityLabel(model.ducksMode ? "Find a duck or person" : "Find a stream, duck or person")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless).foregroundStyle(Theme.muted).accessibilityLabel("Clear search")
                }
                Menu {
                    Toggle("Shared", isOn: Binding(get: { scope == .shared }, set: { scope = $0 ? .shared : .all }))
                } label: { Image(systemName: "line.3.horizontal.decrease.circle") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .foregroundStyle(scope == .shared ? Theme.ink : Theme.muted).help("Filter").accessibilityLabel("Filter ducks")
            }
            .padding(12).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            if scope != .all || !query.isEmpty {
                HStack {
                    Text("\(filtered.dutyCount) of \(layout.dutyCount) ducks · \(scope.title)")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    Spacer()
                    Button("Reset") { scope = .all; query = "" }.buttonStyle(.borderless).font(Typo.meta)
                }
            }
            if filtered.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: layout.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass")
                        .font(.system(size: 24)).foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Text(layout.isEmpty ? "Room for your next idea" : "No matching ducks")
                        .font(Typo.heading).foregroundStyle(Theme.ink)
                    Text(layout.isEmpty ? FirstPondJourney.emptyPondDetail(plainFolder: native?.isPlainFolder == true) : "Try another name or reset the filters to see everything in this pond.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    // No buttons here: "Start a duck" is the overview card's action and "Reset" is on the filter line above.
                }
                .padding(24).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            } else {
                PondWorkspacesView(layout: filtered, members: detail?.members ?? [], showsHeading: false, open: open)
            }
            archivedThreads
        }
    }

    /// "Archived threads (n)": this pond's archived chats, newest archived first, folded until asked for. Opening one
    /// shows it read-only with Unarchive where the composer was.
    @ViewBuilder private var archivedThreads: some View {
        let archived = model.archivedThreads(in: key)
        if let title = ThreadArchive.entryTitle(count: archived.count) {
            VStack(alignment: .leading, spacing: 8) {
                Button { withAnimation(Motion.standard) { archivedOpen.toggle() } } label: {
                    HStack(spacing: 8) {
                        Lucide(archivedOpen ? .chevronDown : .chevronRight, size: 12, color: Theme.subtle).frame(width: 18)
                        Text(verbatim: title.replacingOccurrences(of: "Archived", with: "Archived ducks")).font(Typo.label).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
                if archivedOpen {
                    VStack(spacing: 0) {
                        ForEach(archived) { s in
                            RowOrButton(editing: model.isRenaming(s), action: { model.openFromPond(s.key, pond: key, page: .dashboard) }) {
                                HStack(spacing: 8) {
                                    ThreadDuckView(id: s.key.stringValue, agent: s.agent, size: ThreadDuck.Size.sidebarRow)
                                    if model.isRenaming(s) { InlineTitleEditor(session: s, font: Typo.body) }
                                    else { Text(verbatim: model.workbenchTitle(s)).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1) }
                                    Spacer(minLength: 0)
                                    if let at = s.archivedAt { Text(verbatim: PickerRows.age(at)).font(Typo.meta).foregroundStyle(Theme.subtle) }
                                }
                                .padding(.horizontal, 12).frame(height: 36).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).pointerHand()
                            .squeakContextMenu { RenameThreadItem(session: s) }
                        }
                    }
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                }
            }
        }
    }

    private func startThread() { Self.startThread(key: key, model: model) }

    /// Also the room's "New thread".
    static func startThread(key: String, model: AppModel) {
        let ponds = PondsModel.shared
        let pond = ponds.pond(key: key), native = ponds.native(key: key)
        // A pond with a Git remote starts a thread of its own on this Mac; a project not yet in a pond uses the new-chat flow.
        // A pond in a plain folder starts its thread in the folder through the same route (it has no streams).
        if let pond, !pond.local || native?.isPlainFolder == true {
            switch PondThreadEntry.resolve(pond: pond, workspaces: model.git.workspaces, projectKind: native?.kind,
                                           hasMain: native.flatMap { MainPlace(project: $0) } != nil) {
            case .open(let page, let context): NewChatController.shared.open(page, pondThread: context)
            case .refuse(let why): ponds.note = why
            }
            return
        }
        AppModel.shared.closePondPage()
        if let native {
            if MainPlace(project: native) != nil {
                // A git pond starts in Main, its own folder; the "In:" control above the message picks a stream instead.
                model.openNewMainThread(projectId: native.id)
            } else if let ws = model.git.workspaces.first(where: { $0.projectId == native.id && $0.state != "archived" }) {
                NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: native.id, workspaceId: ws.id))
            } else {
                model.nativeMakeWorkspace(projectId: native.id)
            }
        } else {
            NewChatController.shared.show()
        }
    }

    // MARK: Threads

    private func joinsGroup(_ joins: [JoinRequest]) -> some View {
        PondSection("Waiting to join") {
            VStack(spacing: Space.s) { ForEach(joins) { j in joinCard(j) } }
        }
    }

    private func joinCard(_ j: JoinRequest) -> some View {
        Group { if let pond { JoinRequestCard(pond: pond, join: j) } }
    }

    private func open(_ r: PondChatRow) {
        if let tab = r.local {
            model.openFromPond(tab, pond: key, page: .dashboard)
        } else if let p = pond, let id = r.pondThread {
            AppModel.shared.openPond(.thread(project: key, pondId: p.id, threadId: id))
        }
    }

    // MARK: Ripples

    @ViewBuilder private var ripples: some View {
        let feed = PondRippleFeed.build(detail?.ripples ?? [], me: detail?.meMember?.id ?? detail?.me?.id)
        PondSection("Ripples") {
            VStack(alignment: .leading, spacing: Space.s) {
                if feed.isEmpty {
                    Text("A quiet pond").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("Shared ducks, new members and pond activity will appear here.")
                        .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(feed) { r in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(verbatim: r.sentence).font(Typo.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Text(verbatim: RelativeAge.short(r.at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                    }
                }
            }
            .padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        }
    }
}

// MARK: Pieces

extension PondThreadState {
    /// The panel's own session word for the state (`PondSentence.stateWord`).
    var session: SessionState {
        switch self {
        case .needsYou: .blocked
        case .working: .working
        case .finished: .finished
        case .failed: .error
        }
    }
}

struct PondSection<Content: View>: View {
    let title: String
    let showsHeading: Bool
    let content: Content
    init(_ title: String, showsHeading: Bool = true, @ViewBuilder _ content: () -> Content) {
        self.title = title; self.showsHeading = showsHeading; self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if showsHeading { Text(verbatim: title).font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader) }
            content
        }
    }
}

/// A thread's state, as a mark: the working glyph, the amber triangle that waits on a person, the failed circle. A
/// finished thread has none (its age says enough).
struct PondStateMark: View {
    let state: PondThreadState
    var leading = false

    var body: some View {
        switch state {
        case .working:
            (leading ? WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark) : WorkingGlyph(slot: 24, grid: .compact))
                .accessibilityLabel("Working")
        case .needsYou: StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16).accessibilityLabel("Needs you")
        case .failed: StatusMark(kind: .failed, color: Theme.negative, size: 14).accessibilityLabel("Failed")
        case .finished: EmptyView()
        }
    }
}

/// A person: a coloured initial (a soft disc, never a state colour), an online dot, and a duck ring on you.
struct FlockAvatar: View {
    let member: FlockMember
    var online = false
    var size: CGFloat = 28

    var body: some View {
        Text(verbatim: member.initial).font(.system(size: size * 0.46, weight: .semibold)).foregroundStyle(Theme.ink)
            .frame(width: size, height: size).background(PondColour.avatar(member.colourIndex), in: Circle())
            .overlay { if member.you { Circle().strokeBorder(PondColour.accent, lineWidth: 2) } }
            .overlay(alignment: .bottomTrailing) {
                if online { Circle().fill(Theme.info).frame(width: size * 0.3, height: size * 0.3).overlay(Circle().strokeBorder(Theme.surface, lineWidth: 2)) }
            }
            .accessibilityElement(children: .ignore).accessibilityLabel(member.name + (member.you ? ", you" : "") + (online ? ", online" : ""))
    }
}

/// The pond's icon: its first letter on its own soft tint (or a plain tile before it is a pond).
struct PondTile: View {
    let name: String
    /// The pond record's id (tint, shared badge).
    let pondId: String?
    /// The project's id: its icon.
    var projectId: String?
    var size: CGFloat = 36
    /// On the tinted header the tile is the card's surface, so it still reads against the tint.
    var onTint = false

    var body: some View {
        icon.overlay(alignment: .bottomTrailing) {
            if let badge = PondSharing.badge(for: PondsModel.shared.ponds.first { $0.id == pondId }) {
                SharedPondBadge(badge: badge, size: max(12, (size * 0.36).rounded())).offset(x: size * 0.12, y: size * 0.12)
            }
        }
    }

    @ViewBuilder private var icon: some View {
        if let img = PondIcons.shared.icon(projectId: projectId, name: name) {
            // An image icon fills the same tile as the letter: no pond tint behind it.
            Image(nsImage: img).resizable().scaledToFill().frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)).accessibilityHidden(true)
        } else {
            Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(Theme.ink)
                .frame(width: size, height: size)
                .background(onTint ? Theme.surface : PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
                .accessibilityHidden(true)
        }
    }
}

/// The small circle on a shared pond's icon: the sharer's initials on a muted disc, or a people symbol when no name is
/// known, ringed in the sidebar colour so it reads as a badge. Tooltip and VoiceOver say who shared it.
struct SharedPondBadge: View {
    let badge: PondSharing.Badge
    var size: CGFloat = 14

    var body: some View {
        ZStack {
            Circle().fill(Theme.selected)
            if let initials = badge.initials {
                Text(verbatim: initials).font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(Theme.ink).minimumScaleFactor(0.6)
            } else {
                Image(systemName: "person.2.fill").font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(Theme.muted)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(Theme.sidebar, lineWidth: 1.5).padding(-1.5))
        .help(badge.label).accessibilityElement().accessibilityLabel(badge.label)
    }
}

/// The pond's members and what each is in, with "Remove from pond…" for those who may: the pond home's Flock and the
/// settings page's, one view.
struct PondFlockSection: View {
    /// The pond's directory key; `project` reads its name.
    let key: String
    private var project: String { ponds.name(key: key) }
    var dashboard = false
    var showsHeading = true
    @Environment(AppModel.self) private var model
    @State private var removing: FlockMember?

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var person: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var layout: PondHomeLayout {
        PondHomeLayout.build(
            project: model.pondProject(key), detail: detail, me: person,
            hostIdFor: { model.hostId($0) }, titleFor: { model.workbenchTitle($0) }, markFor: { model.mark(for: $0) },
            hiddenThreads: ponds.hides.hiddenIds, ownThreads: ponds.ownThreads)
    }

    var body: some View {
        let counts = layout.chatCounts
        let presence = detail?.presence ?? []
        let published = pond.map { !$0.local } ?? false
        // A shared pond with nothing read yet shows its state, never a flock of one drawn as if it were real.
        let unread = detail == nil && published
        let members = detail.map { PondFlock.ordered($0.members, presence: presence) }
            ?? [FlockMember(id: "me", name: person, role: .owner, nest: "This Mac", online: true, you: true)]
        let offline = ponds.freshness(pond).isProblem
        let canWrite = ponds.freshness(pond).canWrite
        return PondSection("Flock", showsHeading: showsHeading) {
            VStack(alignment: .leading, spacing: Space.s) {
                if !dashboard { Text(verbatim: PondStates.flockGloss).font(Typo.footnote).foregroundStyle(Theme.muted) }
                if unread {
                    Text(verbatim: ponds.freshness(pond).line ?? "Reading the pond\u{2026}").font(Typo.footnote).foregroundStyle(Theme.muted)
                }
                LazyVGrid(columns: dashboard ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 220), spacing: Space.s)], alignment: .leading, spacing: Space.s) {
                    ForEach(unread ? [] : members) { m in memberRow(m, counts: counts, presence: presence, offline: offline, canWrite: canWrite) }
                }
                if let pond, let line = ponds.result[pond.id] { Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted) }
            }
        }
        .confirmationDialog(
            "Remove \(removing?.name ?? "this person") from \(project)?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let m = removing, let p = pond { Task { await ponds.removeMember(pond: p.id, member: m.id) } }
                removing = nil
            }
            Button("Cancel", role: .cancel) { removing = nil }
        } message: {
            Text("The pond\u{2019}s key changes, so they can\u{2019}t read anything new. Their own Mac keeps what it already has.")
        }
    }

    @ViewBuilder private func memberActions(_ m: FlockMember) -> some View {
            ForEach(PondMembers.rolesToChangeTo(m), id: \.self) { r in
                Button("Make \(r.word.lowercased())") { if let p = pond { Task { await ponds.setRole(pond: p.id, member: m.id, role: r) } } }
            }
            if m.role != .owner {
                Divider()
                ForEach(PondPresets.presets(ownThreads: ponds.ownThreads), id: \.key) { preset in
                    Button((PondPresets.current(m) == preset.key ? "\u{2713} " : "") + preset.title) {
                        if let p = pond { Task { await ponds.setPreset(pond: p.id, member: m.id, preset: preset.key) } }
                    }
                }
                ForEach(PondPresets.switches(ownThreads: ponds.ownThreads), id: \.key) { sw in
                    let on = PondPresets.value(m, sw.key)
                    Button((on ? "\u{2713} " : "") + sw.title) {
                        if let p = pond { Task { await ponds.setCap(pond: p.id, member: m.id, cap: sw.key, on: !on) } }
                    }
                }
                Divider()
            }
            Button("Remove from pond\u{2026}", role: .destructive) { removing = m }
    }

    private func memberRow(_ m: FlockMember, counts: [String: Int], presence: [PondPresenceEntry], offline: Bool, canWrite: Bool) -> some View {
        let removingNow = pond.map { ponds.isBusy("remove:\($0.id):\(m.id)") } ?? false
        let changing = pond.map { ponds.isBusy("role:\($0.id):\(m.id)") } ?? false
        let seen = detail.flatMap { PondMembers.seen(m, presence: presence, threads: $0.threads, pondOffline: offline, now: Date()) }
        let tail = [seen, PondMembers.machine(m)].compactMap { $0 }.joined(separator: " \u{00B7} ")
        return HStack(spacing: Space.s) {
            FlockAvatar(member: m, online: PondFlock.isOnline(m, presence: presence) && !offline, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: m.you ? "\(m.name) (you)" : m.name).font(Typo.label).foregroundStyle(Theme.ink)
                        .lineLimit(dashboard ? 2 : 1).help(m.name)
                    Text(verbatim: PondMembers.chip(m)).font(Typo.meta).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).frame(height: 18).background(Theme.selected, in: Capsule())
                    if let n = PondDevices.countLine(m) { Text(verbatim: n).font(Typo.meta).foregroundStyle(Theme.muted) }
                }
                Text(verbatim: (removingNow ? "Removing\u{2026}" : changing ? "Changing role\u{2026}" : (detail == nil ? "You \u{00B7} This Mac" : tail))
                    + PondWorkspacesView.countSuffix(counts[m.id] ?? (m.you && detail == nil ? counts["me"] : nil)))
                    .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(dashboard ? 3 : 1)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if !dashboard, role.canRemoveMembers, !m.you, pond != nil {
                SqueakMenu { memberActions(m) } label: { Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("More for \(m.name)")
                    .disabled(removingNow || changing || !canWrite)
            }
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .opacity(removingNow ? 0.6 : 1)
        .contextMenu {
            if dashboard, role.canRemoveMembers, !m.you, pond != nil, !removingNow, !changing, canWrite { memberActions(m) }
        }
    }
}

/// The one top bar's layout, from plain data: the same view draws the live bar and the offscreen snapshots. Spacing alone
/// separates logo, name, switch and tabs (`PondBarMetrics`); the controls share one height and are centred with air above
/// and below.
struct PondTopBar<Tile: View, Tabs: View, Trailing: View>: View {
    let name: String
    let subtitle: String
    var leadingInset: CGFloat = 0
    let switchSelection: Binding<PondPage?>
    var hasTabs = true
    @ViewBuilder let tile: () -> Tile
    @ViewBuilder let tabs: () -> Tabs
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 0) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            // Flow: hover the icon or name to read who is here and how many Ducks are on duty (the subtitle lives only here).
            HStack(spacing: CGFloat(PondBarMetrics.logoGap)) {
                tile()
                Text(verbatim: name).font(.system(size: 15, weight: .semibold)).tracking(-0.1).foregroundStyle(Theme.ink)
                    .lineLimit(1).fixedSize().accessibilityAddTraits(.isHeader)
            }
            .help(subtitle)
            .accessibilityElement(children: .combine).accessibilityLabel("\(name), \(subtitle)")
            RoomSegmented(
                items: PondPage.allCases.map(Optional.some), selection: switchSelection,
                title: { $0?.title ?? "" }, height: CGFloat(PondBarMetrics.controlHeight), capsule: true)
                .fixedSize().accessibilityLabel("Pond view")
                .padding(.leading, CGFloat(PondBarMetrics.sectionGap))
            if hasTabs { tabs().padding(.leading, CGFloat(PondBarMetrics.sectionGap)) }
            if !hasTabs { Spacer(minLength: 0) }
            trailing().padding(.leading, CGFloat(PondBarMetrics.trailingGap))
        }
        // No hairline under the bar: it sits on the one quiet Pond-tinted surface with the Duck subheader.
        .padding(.horizontal, CGFloat(PondBarMetrics.endInset)).frame(height: CGFloat(PondBarMetrics.height))
    }
}

/// The one top bar of the new layout: the same view, in the same place, on the Dashboard, the Room, an item and inside a Duck
/// (WorkbenchCentre hosts it above every page, so it never moves or rebuilds).
struct PondSharedHeader: View {
    let key: String
    let projectId: String
    var member = false
    var leadingInset: CGFloat = 0
    var itemShowing = false
    /// A Duck's chat is showing: neither page is selected, and picking one leaves the Duck for it.
    var inDuck = false
    /// The New duck page is the centre: neither page, no Duck and no item is selected.
    var newDuck = false
    /// The Pond's strip (oval tabs), drawn in this same row after the switch; nil draws no strip.
    var workspace: PondWorkspace?
    var strip: PondWorkspaceStrip?
    @Environment(AppModel.self) private var model

    var body: some View {
        let name = PondsModel.shared.name(key: key)
        let people = PondsModel.shared.detail(key: key)?.members.count ?? 1
        let subtitle = RoomDucks.subtitle(people: people, counts: PondsModel.shared.native(key: key).flatMap { RoomRosterStore.shared.model(for: $0.id).counts })
        let centre = PondCentre(page: RoomViewPref.shared.mode(for: key), duck: inDuck ? (strip?.row.selectedDuck ?? "") : nil,
                                item: itemShowing ? (strip?.currentItem ?? TabItem(.notebook, "")) : nil, newDuck: newDuck)
        PondTopBar(
            name: name, subtitle: subtitle, leadingInset: leadingInset,
            switchSelection: Binding<PondPage?>(get: { centre.switchSelection },
                set: { page in
                    guard let page else { return }
                    // One source of truth for what the centre shows (PondCentre): the switch writes it, the page reads it.
                    // Flow: from inside a Duck, the switch goes to that page of the Pond.
                    model.applyCentre(pond: key) { $0.switchTo(page) }
                }),
            hasTabs: !(strip?.isEmpty ?? true),
            tile: {
                PondTile(name: name, pondId: PondsModel.shared.pond(key: key)?.id,
                         projectId: PondsModel.shared.native(key: key)?.id, size: 32)
            },
            tabs: {
                if let workspace, let strip {
                    PondWorkspaceTabStrip(workspace: workspace, strip: strip, embedded: true).id(workspace.project.id)
                }
            },
            trailing: { if centre.showsPondMenu { PondHeaderMenu(key: key) } })
        .background(WindowDragArea())
    }
}
