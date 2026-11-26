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
            Color.clear.onAppear { AppModel.shared.prunePonds(live: PondsModel.shared.liveKeys) }
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
                    // The Dashboard carries its own ⋯ in its header; only the Room switch (and a waiting Pond's Leave) sit here.
                    if let waiting = PondsModel.shared.pond(key: project), PondStates.isGreyedRow(waiting) {
                        if PondsModel.shared.chrome(key: project).showsLeave { PondHeaderMenu(key: project, withActions: false).padding(.trailing, Space.xl) }
                    } else if PondsModel.shared.native(key: project) != nil || roomProject(project) != nil {
                        RoomModeSwitch(key: project).padding(.trailing, Space.xl)
                    }
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
    private var person: String { PondsModel.shared.myName.isEmpty ? "You" : PondsModel.shared.myName }
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
            if m.role != .owner { Divider() }
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
                    Text(verbatim: m.you ? "\(PersonName.shown(m)) (you)" : PersonName.shown(m)).font(Typo.label).foregroundStyle(Theme.ink)
                        .lineLimit(dashboard ? 2 : 1).help(PersonName.emailLine(m) ?? PersonName.shown(m))
                    Text(verbatim: PondMembers.chip(m)).font(Typo.meta).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 6).frame(height: 18).background(Theme.selected, in: Capsule())
                }
                if let email = PersonName.emailLine(m) {
                    Text(verbatim: email).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
                if let failed = pond.flatMap({ ponds.actions.failure("remove:\($0.id):\(m.id)") }) {
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(verbatim: failed).font(Typo.meta).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                        Button(PondActionWords.tryAgain) { if let p = pond { Task { await ponds.retry(action: "remove:\(p.id):\(m.id)", pond: p.id) } } }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                }
                Text(verbatim: (removingNow ? (pond.flatMap { ponds.actions.line("remove:\($0.id):\(m.id)") } ?? "Removing\u{2026}") : changing ? "Changing role\u{2026}" : (detail == nil ? "You \u{00B7} This Mac" : tail))
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
    /// What the centre shows (`PondCentre.switchSelection`): nil while a Duck or an item covers the pages.
    let switchSelection: PondPage?
    /// The pond's strip, so the pill slides with a swipe; nil draws the pill at rest under the selection.
    var strip: PondPanState?
    /// A fixed progress, for snapshots.
    var switchProgress: Double?
    let pick: (PondPage) -> Void
    var hasTabs = true
    /// The Pond's name lives in the Dashboard header (DESIGN.md 8.12); the bar shows it only where a caller asks.
    var showsName = true
    @ViewBuilder let tile: () -> Tile
    @ViewBuilder let tabs: () -> Tabs
    @ViewBuilder let trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 0) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            // Flow: hover the icon or name to read who is here and how many Ducks are on duty (the subtitle lives only here).
            if showsName {
                HStack(spacing: CGFloat(PondBarMetrics.logoGap)) {
                    tile()
                    Text(verbatim: name).font(.system(size: 15, weight: .semibold)).tracking(-0.1).foregroundStyle(Theme.ink)
                        .lineLimit(1).fixedSize().accessibilityAddTraits(.isHeader)
                }
                .help(subtitle)
                .accessibilityElement(children: .combine).accessibilityLabel("\(name), \(subtitle)")
            }
            PondPageSwitch(selection: switchSelection, strip: strip, progress: switchProgress, pick: pick)
                .padding(.leading, showsName ? CGFloat(PondBarMetrics.sectionGap) : 0)
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
            switchSelection: centre.switchSelection,
            strip: PondPanStore.shared.state(for: key),
            // One source of truth for what the centre shows (PondCentre): the switch writes it, the page reads it.
            // Flow: from inside a Duck, the switch goes to that page of the Pond.
            pick: { page in model.applyCentre(pond: key) { $0.switchTo(page) } },
            hasTabs: !(strip?.isEmpty ?? true),
            // The name and tile live in the Dashboard's header: the bar keeps the switch (and the tabs).
            showsName: false,
            tile: {
                PondTile(name: name, pondId: PondsModel.shared.pond(key: key)?.id,
                         projectId: PondsModel.shared.native(key: key)?.id, size: 32)
            },
            tabs: {
                if let workspace, let strip {
                    PondWorkspaceTabStrip(workspace: workspace, strip: strip, embedded: true).id(workspace.project.id)
                }
            },
            // The Dashboard's ⋯ is in its header; the Room and items keep it here.
            trailing: { if centre.showsPondMenu, centre.switchSelection != .dashboard { PondHeaderMenu(key: key, withActions: true) } })
        .background(WindowDragArea())
        // The bar owns the Pond's roster feed. It used to start only from views that mount once the strip has tabs (the strip
        // itself, the Dashboard, the Room): a chat opened first after a launch (restored, sidebar, deep link) had an empty
        // roster, so the strip was empty, never mounted, and never fetched: no tabs, no selected Duck, a bare subheader.
        .task(id: workspace?.project.id) { workspace?.roster.keepFresh(host: model.nativeHost) }
    }
}
