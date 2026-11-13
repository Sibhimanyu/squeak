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
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size) }
                Spacer(minLength: 0)
            }
            .frame(height: Metrics.header).background(WindowDragArea())
            switch route {
            case .home(let project):
                if let waiting = PondsModel.shared.pond(named: project), PondStates.isGreyedRow(waiting) {
                    ScrollView {
                        JoinWaitingCard(pond: waiting) { PondsModel.shared.route = nil }
                            .frame(maxWidth: 520).padding(Space.xl).frame(maxWidth: .infinity, alignment: .top)
                    }.screen("Pond")
                } else {
                    PondHomeView(project: project).id(project).screen("Pond")
                }
            case .settings(let project): PondSettingsView(project: project).screen("Pond settings")
            case .thread(let project, let pondId, let threadId):
                PondThreadView(project: project, pondId: pondId, threadId: threadId).id(threadId).screen("Thread")
            }
        }
    }
}

struct PondHomeView: View {
    let project: String
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var scope: PondDashboardScope = .all

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(named: project) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var native: NativeProject? { NativeWorkspaceMaking.project(named: project, in: model.native.projects) }
    private var localSessions: [HostSession] {
        model.sidebarTree.projects.first { $0.name.caseInsensitiveCompare(project) == .orderedSame }?.workspaces.flatMap(\.chats) ?? []
    }
    private var person: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }

    private var layout: PondHomeLayout {
        PondHomeLayout.build(
            project: model.sidebarTree.projects.first { $0.name.caseInsensitiveCompare(project) == .orderedSame }, detail: detail, me: person,
            emptyBranches: PondHomeLayout.emptyBranches(model.git.workspaces, projectId: native?.id, chats: localSessions),
            hostIdFor: { model.hostId($0) }, titleFor: { model.workbenchTitle($0) }, markFor: { model.mark(for: $0) })
    }

    var body: some View {
        let layout = layout
        let joins = role.canApproveJoins ? (detail?.joins ?? []) : []
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header
                    PondFreshnessStrip(pond: pond)
                    if let note = ponds.note {
                        Label(note, systemImage: "info.circle")
                            .font(Typo.footnote).foregroundStyle(Theme.muted).textSelection(.enabled)
                    }
                    if let line = pond.flatMap({ ponds.result[$0.id] }) {
                        Label(line, systemImage: "checkmark.circle").font(Typo.footnote).foregroundStyle(Theme.muted)
                    }
                    overview(layout, compact: geometry.size.width < 650)
                    if !joins.isEmpty { joinsGroup(joins) }
                    let columns = geometry.size.width >= 900
                        ? AnyLayout(HStackLayout(alignment: .top, spacing: 28))
                        : AnyLayout(VStackLayout(alignment: .leading, spacing: 28))
                    columns {
                        threads(layout).frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .leading, spacing: 28) {
                            PondFlockSection(project: project, dashboard: true)
                            if let pond, role.canInvite, !pond.local { PondInvitesSection(pond: pond) }
                            ripples
                        }
                        .frame(width: geometry.size.width >= 900 ? 260 : nil, alignment: .leading)
                    }
                }
                .padding(geometry.size.width < 600 ? 20 : 32)
                .frame(maxWidth: 1200, alignment: .leading).frame(maxWidth: .infinity)
            }
        }
        .background(Theme.bg)
        .onAppear { ponds.note = nil }
        .pondHeartbeat(pond: pond?.id)
    }

    // MARK: Identity and overview

    private var header: some View {
        VStack(alignment: .leading, spacing: 20) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 20) {
                    identity
                    Spacer(minLength: 16)
                    actions
                }
                VStack(alignment: .leading, spacing: 20) {
                    identity
                    actions
                }
            }
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: pond?.local ?? true ? "desktopcomputer" : "person.2")
                    .accessibilityHidden(true)
                Text(verbatim: accessDescription).fixedSize(horizontal: false, vertical: true)
            }
            .font(Typo.footnote).foregroundStyle(Theme.muted)
        }
        .padding(24)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 2).fill(PondColour.tint(pond?.id))
                .frame(width: 44, height: 4).padding(.leading, 24)
        }
    }

    private var identity: some View {
        HStack(spacing: 14) {
            PondTile(name: project, pondId: pond?.id, size: 52)
            VStack(alignment: .leading, spacing: 4) {
                Text("Pond overview").font(Typo.footnote).foregroundStyle(Theme.muted)
                Text(verbatim: project).font(.system(size: 28, weight: .semibold))
                    .tracking(-0.6).foregroundStyle(Theme.ink).lineLimit(2)
                    .textSelection(.enabled).accessibilityAddTraits(.isHeader)
            }
        }
    }

    private var actions: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { inviteAction; shareAction; startAction; settingsAction }
            VStack(alignment: .leading, spacing: 10) {
                startAction
                HStack(spacing: 8) { inviteAction; shareAction; settingsAction }
            }
        }
    }

    @ViewBuilder private var inviteAction: some View {
        if role.canInvite, let p = pond {
            Button("Invite") { ponds.startInvite(pondId: p.id, account: model.account) }
                .buttonStyle(SecondaryButtonStyle()).disabled(!ponds.freshness(p).canWrite)
                .help(ponds.freshness(p).writesDisabledReason ?? "Invite someone to this pond")
        }
    }

    @ViewBuilder private var shareAction: some View {
        if let p = pond, !p.local, role.canMessage { shareMenu(p) }
    }

    @ViewBuilder private var startAction: some View {
        if pond == nil || pond?.local == true || pond.map({ PondStartThread.offer(for: $0) }) == .start {
            Button { startThread() } label: { Label("Start a thread", systemImage: "plus") }
                .buttonStyle(PondPrimaryButtonStyle())
        }
    }

    private var settingsAction: some View {
        Button { ponds.route = .settings(project: project) } label: {
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

    private func overview(_ layout: PondHomeLayout, compact: Bool) -> some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: compact ? 2 : 4), spacing: 12) {
            ForEach(PondDashboardScope.allCases, id: \.self) { item in
                Button { scope = item } label: {
                    VStack(alignment: .leading, spacing: 12) {
                        HStack(spacing: 6) {
                            if item == .needsYou {
                                Lucide(.triangleAlert, size: 13, color: layout.count(in: item) > 0 ? Theme.warning : Theme.muted)
                            }
                            Text(verbatim: item.title).font(Typo.footnote).foregroundStyle(Theme.muted)
                        }
                        Text(verbatim: "\(layout.count(in: item) + (item == .needsYou && role.canApproveJoins ? (detail?.joins.count ?? 0) : 0))")
                            .font(.system(size: 28, weight: .medium)).monospacedDigit().foregroundStyle(Theme.ink)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    .background(scope == item ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("\(item.title), \(layout.count(in: item)) threads")
                .accessibilityAddTraits(scope == item ? .isSelected : [])
                .help("Show \(item.title.lowercased())")
            }
        }
    }

    private func threads(_ layout: PondHomeLayout) -> some View {
        let filtered = layout.filtered(query: query, scope: scope)
        return VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                Text("Streams & threads").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer()
                if let native {
                    Button { model.nativeMakeWorkspace(projectId: native.id) } label: { Label("New stream", systemImage: "plus") }
                        .buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
                }
            }
            Text("Each stream is a separate working folder. Its threads work with the same files.")
                .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Theme.muted).accessibilityHidden(true)
                TextField("Find a stream, thread or person", text: $query).textFieldStyle(.plain)
                    .font(Typo.body).accessibilityLabel("Find a stream, thread or person")
                if !query.isEmpty {
                    Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                        .buttonStyle(.borderless).foregroundStyle(Theme.muted).accessibilityLabel("Clear search")
                }
            }
            .padding(12).background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
            if scope != .all || !query.isEmpty {
                HStack {
                    Text("\(filtered.threadCount) of \(layout.threadCount) threads · \(scope.title)")
                        .font(Typo.meta).foregroundStyle(Theme.muted)
                    Spacer()
                    Button("Reset") { scope = .all; query = "" }.buttonStyle(.borderless).font(Typo.meta)
                }
            }
            if filtered.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    Image(systemName: layout.isEmpty ? "bubble.left.and.bubble.right" : "magnifyingglass")
                        .font(.system(size: 24)).foregroundStyle(Theme.muted).accessibilityHidden(true)
                    Text(layout.isEmpty ? "Room for your next idea" : "No matching threads")
                        .font(Typo.heading).foregroundStyle(Theme.ink)
                    Text(layout.isEmpty ? "Start a thread to work with an agent. Your streams and conversations will live here." : "Try another name or reset the filters to see everything in this pond.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    if layout.isEmpty {
                        if pond == nil || pond?.local == true || pond.map({ PondStartThread.offer(for: $0) }) == .start {
                            Button("Start a thread") { startThread() }.buttonStyle(SecondaryButtonStyle())
                        }
                    } else {
                        Button("Reset filters") { scope = .all; query = "" }.buttonStyle(SecondaryButtonStyle())
                    }
                }
                .padding(24).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            } else {
                PondWorkspacesView(layout: filtered, members: detail?.members ?? [], showsHeading: false, open: open)
            }
        }
    }

    /// Threads on this Mac not yet in the pond.
    private func shareMenu(_ p: PondSummary) -> some View {
        let shared = Set((detail?.threads ?? []).compactMap(\.sessionId))
        let candidates = localSessions.compactMap { s in model.hostId(s).map { (s, $0) } }.filter { !shared.contains($0.1) }
        return SqueakMenu("Share a thread") {
            ForEach(candidates, id: \.1) { s, id in
                Button(model.workbenchTitle(s)) { Task { await ponds.share(pond: p.id, sessionId: id) } }
                Button("\(model.workbenchTitle(s)) (private)") { Task { await ponds.share(pond: p.id, sessionId: id, isPrivate: true) } }
            }
        }
        .menuStyle(.button).buttonStyle(SecondaryButtonStyle()).fixedSize()
        .disabled(candidates.isEmpty)
        .help(candidates.isEmpty ? (localSessions.isEmpty ? "No chats on this Mac to share yet" : "Every thread on this Mac is already in the pond") : "Show one of this Mac\u{2019}s threads to the flock")
    }

    private func startThread() {
        // A pond with a Git remote starts a thread of its own on this Mac; a project not yet in a pond uses the new-chat flow.
        if let pond, !pond.local {
            ponds.sheet = .startThread(pondId: pond.id, pondName: pond.name)
            return
        }
        ponds.route = nil
        if let native {
            if let ws = model.git.workspaces.first(where: { $0.projectId == native.id && $0.state != "archived" }) {
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
        if let key = r.local {
            ponds.route = nil
            model.select(key)
        } else if let p = pond, let id = r.pondThread {
            ponds.route = .thread(project: project, pondId: p.id, threadId: id)
        }
    }

    // MARK: Ripples

    @ViewBuilder private var ripples: some View {
        let feed = PondRippleFeed.build(detail?.ripples ?? [], me: detail?.meMember?.id ?? detail?.me?.id)
        PondSection("Ripples") {
            VStack(alignment: .leading, spacing: Space.s) {
                if feed.isEmpty {
                    Text("A quiet pond").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("Shared threads, new members and pond activity will appear here.")
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

    var body: some View {
        switch state {
        case .working: WorkingGlyph(width: 20, height: 15).accessibilityLabel("Working")
        case .needsYou: Lucide(.triangleAlert, size: 14, color: Theme.warning).accessibilityLabel("Needs you")
        case .failed: Lucide(.circleX, size: 14, color: Theme.negative).accessibilityLabel("Failed")
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
    let pondId: String?
    var size: CGFloat = 36
    /// On the tinted header the tile is the card's surface, so it still reads against the tint.
    var onTint = false

    var body: some View {
        if let img = PondIcons.shared.icon(named: name) {
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

/// The pond's members and what each is in, with "Remove from pond…" for those who may: the pond home's Flock and the
/// settings page's, one view.
struct PondFlockSection: View {
    let project: String
    var dashboard = false
    var showsHeading = true
    @Environment(AppModel.self) private var model
    @State private var removing: FlockMember?

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(named: project) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var person: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var layout: PondHomeLayout {
        PondHomeLayout.build(
            project: model.sidebarTree.projects.first { $0.name.caseInsensitiveCompare(project) == .orderedSame }, detail: detail, me: person,
            hostIdFor: { model.hostId($0) }, titleFor: { model.workbenchTitle($0) }, markFor: { model.mark(for: $0) })
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
                Text(verbatim: PondStates.flockGloss).font(Typo.footnote).foregroundStyle(Theme.muted)
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
                }
                Text(verbatim: (removingNow ? "Removing\u{2026}" : changing ? "Changing role\u{2026}" : (detail == nil ? "You \u{00B7} This Mac" : tail))
                    + PondWorkspacesView.countSuffix(counts[m.id] ?? (m.you && detail == nil ? counts["me"] : nil)))
                    .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(dashboard ? 3 : 1)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if role.canRemoveMembers, !m.you, pond != nil {
                SqueakMenu {
                    ForEach(PondMembers.rolesToChangeTo(m), id: \.self) { r in
                        Button("Make \(r.word.lowercased())") { if let p = pond { Task { await ponds.setRole(pond: p.id, member: m.id, role: r) } } }
                    }
                    Button("Remove from pond\u{2026}", role: .destructive) { removing = m }
                } label: { Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("More for \(m.name)")
                    .disabled(removingNow || changing || !canWrite)
            }
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .opacity(removingNow ? 0.6 : 1)
    }
}
