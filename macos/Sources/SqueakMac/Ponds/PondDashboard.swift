import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, the Pond's Dashboard (docs/spec.md "Pond journey and Dashboard"). One header (name, one state line, the
// people, the buttons the role may press, ⋯), then only the blocks that have something: Needs you, Ducks, Latest in the
// Room. What the page says and offers is decided in SqueakMacCore (`PondDashboardPlan.swift`); this only draws it.

extension PondsModel {
    /// The Dashboard header's plan for this Pond and this person (also the ⋯ menu's).
    func dashboardHeader(key: String) -> PondDashboardHeader {
        let pond = self.pond(key: key), chrome = self.chrome(key: key)
        let role = detail(key: key)?.myRole ?? pond?.role ?? .owner
        let freshness = self.freshness(pond)
        var blocked: String?
        if let p = pond, !chrome.isRemote, role.canMessage {
            switch PondStartThread.offer(for: p) {
            case .shareOnly(let why) where !p.local && !PondStartThread.runsOnOwnerMac(p): blocked = why
            case .none where !p.local: blocked = "Squeak can\u{2019}t start a duck in this Pond from this Mac."
            default: break
            }
        }
        return PondDashboardHeader.make(.init(
            role: role, hasPond: pond != nil, isLocal: pond?.local ?? true, plainFolder: native(key: key)?.isPlainFolder == true,
            isRemote: chrome.isRemote, ownerName: pond?.ownerName, people: detail(key: key)?.members.count ?? pond?.memberCount ?? 1,
            connection: PondConnection.resolve(pond?.connection, freshness: freshness, role: role), connectionLine: pond?.connection?.line, start: chrome.start, startBlockedReason: blocked, canWrite: freshness.canWrite))
    }
}

struct PondHomeView: View {
    /// The pond's directory key; `project` reads its name.
    let key: String
    private var project: String { ponds.name(key: key) }
    @Environment(AppModel.self) private var model
    @State private var offDutyOpen = false
    @State private var confirmGitPond = false
    @State private var gitPondBusy = false
    @State private var gitFailure: String?

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(key: key) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var native: NativeProject? { ponds.native(key: key) }
    private var roster: RoomRosterModel? { native.map { RoomRosterStore.shared.model(for: $0.id) } }
    private var localSessions: [HostSession] { model.pondProject(key).workspaces.flatMap(\.chats) }
    private var person: String { PondsModel.shared.myName.isEmpty ? "You" : PondsModel.shared.myName }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }
    private var chrome: PondChrome { ponds.chrome(key: key) }
    private var room: PondRoomModel? { PondRouteView.roomProject(key).map { PondRoomStore.shared.model(for: $0.id, member: $0.member) } }

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

    var body: some View {
        let plan = ponds.dashboardHeader(key: key)
        let ducks = PondDuckSections.build(layout)
        let joins = role.canApproveJoins ? (detail?.joins ?? []) : []
        let needs = PondDashboardNeedsYou.build(
            rows: ducks.onDuty + ducks.offDuty, tasks: room?.feed.jobs ?? [], joins: joins, role: role, ownerName: pond?.ownerName,
            starts: detail?.starts ?? [])
        let latest = PondLatest.build(room?.feed.rows.map(\.post) ?? [])
        let blocks = PondDashboardBlocks.of(needsYou: needs.count, ducks: ducks, latest: latest.count)
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    header(plan)
                    if blocks.needsYou { needsYou(needs, ducks: ducks, joins: joins) }
                    if blocks.emptyGuide { emptyGuide } else { ducksBlock(ducks, blocks: blocks) }
                    if blocks.latest { latestBlock(latest) }
                }
                .padding(geometry.size.width < 600 ? 20 : 32)
                .frame(maxWidth: PondInspectorSections.dashboardContentWidth, alignment: .leading).frame(maxWidth: .infinity)
                .background(ScrollMemory(id: "pond:\(key):dashboard"))
            }
            .scrollIndicators(.hidden)   // no scroll bar riding along in the Dashboard/Room slide
        }
        .background(Theme.bg)
        .onAppear { ponds.note = nil; _ = PondScopeRequest.shared.take(pond: key) }
        // A pond's mark clicked while this page is already open: Needs you is the first block, so there is nothing to scroll to.
        .onChange(of: PondScopeRequest.shared.pending[key]) { _, asked in if asked != nil { _ = PondScopeRequest.shared.take(pond: key) } }
        .pondHeartbeat(pond: pond?.id)
        .task(id: native?.id) { roster?.keepFresh(host: model.nativeHost) }
        // The Latest block reads the Room even while the Room page is not open (a quiet catch-up, never a second stream).
        .task(id: room?.projectId) { if let room { await room.warm(host: model.nativeHost) } }
        .gitPondFlow(key: key, ask: $confirmGitPond, busy: $gitPondBusy, failure: $gitFailure)
    }

    // MARK: Header

    private func header(_ plan: PondDashboardHeader) -> some View {
        let people = detail.map { PondFlock.ordered($0.members, presence: $0.presence) } ?? []
        let avatars = PondAvatarRow.build(
            people: people.isEmpty ? [(id: "me", name: person, you: true)] : people.map { (id: $0.id, name: PersonName.shown($0), you: $0.you) },
            pendingInvites: role.canInvite ? (detail?.invites.filter { $0.state == .pending }.count ?? 0) : 0)
        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 14) {
                PondTile(name: project, pondId: pond?.id, projectId: native?.id, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: project).font(Typo.title).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                        .accessibilityAddTraits(.isHeader)
                    stateLine(plan)
                }
                Spacer(minLength: 0)
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { avatarRow(avatars); Spacer(minLength: 12); buttons(plan) }
                VStack(alignment: .leading, spacing: 12) { avatarRow(avatars); buttons(plan) }
            }
            if let line = plan.closedLine {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            if let failure = gitFailure { gitFailureLine(failure) }
            if let note = ponds.note ?? pond.flatMap({ ponds.result[$0.id] }) {
                Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
        }
    }

    /// The one state line; a read that failed offers Try again beside it, a slow read shows the working mark in a fixed slot.
    private func stateLine(_ plan: PondDashboardHeader) -> some View {
        let freshness = ponds.freshness(pond)
        return HStack(spacing: 8) {
            Text(verbatim: plan.stateLine).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
            if case .couldntRead = freshness, let id = pond?.id {
                Button("Try again") { ponds.retry(id) }.buttonStyle(.borderless).font(Typo.footnote)
            }
        }
    }

    private func avatarRow(_ row: PondAvatarRow) -> some View {
        // Flow: the avatars open the Pond's people (its settings, where members and invites are listed).
        Button { model.openSettings(.pond(key)) } label: {
            HStack(spacing: -6) {
                ForEach(row.items) { item in
                    switch item {
                    case .person(let id, let name, let you):
                        FlockAvatar(member: FlockMember(id: id, name: name, you: you), online: false, size: 28)
                            .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2))
                    case .pending:
                        Image(systemName: "envelope").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            .frame(width: 28, height: 28)
                            .overlay(Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5))
                            .background(Theme.bg, in: Circle())
                            .help("Invited, not joined yet").accessibilityLabel("Invited, not joined yet")
                    }
                }
                if row.more > 0 {
                    Text(verbatim: "+\(row.more)").font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, 12)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand()
        .help("People in this Pond").accessibilityLabel("People in this Pond")
    }

    private func buttons(_ plan: PondDashboardHeader) -> some View {
        HStack(spacing: 8) {
            startButton(plan.start)
            if plan.showsInvite, let p = pond {
                Button { ponds.startInvite(pondId: p.id, account: model.account) } label: { Text("Invite").lineLimit(1).fixedSize() }
                    .buttonStyle(SecondaryButtonStyle()).disabled(plan.inviteDisabledReason != nil)
                    .help(plan.inviteDisabledReason ?? "Invite someone to this Pond")
            }
            if plan.showsPutOnGitHub { putOnGitHub }
            PondHeaderMenu(key: key)
        }
    }

    @ViewBuilder private func startButton(_ start: PondDashboardHeader.Start) -> some View {
        switch start {
        case .open(let label, let help):
            Button { Self.startThread(key: key, model: model) } label: { Label(label, systemImage: "plus").lineLimit(1).fixedSize() }
                .buttonStyle(PondPrimaryButtonStyle()).help(help)
        case .closed(let reason):
            // Drawn closed (a lock, no fill) with its reason one line below; it cannot be pressed, and says why.
            Label(PondDashboardHeader.startLabel, systemImage: "lock").lineLimit(1).fixedSize()
                .font(Typo.label).foregroundStyle(Theme.muted).padding(.horizontal, 12).frame(minHeight: 28)
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.lineStrong))
                .help(reason).accessibilityLabel("\(PondDashboardHeader.startLabel), closed. \(reason)")
        case .hidden: EmptyView()
        }
    }

    /// Flow: Put on GitHub asks private or public, makes the repository, publishes the folder and turns on Streams; the button
    /// says Putting on GitHub… until it is done and the failure stays below with Try again.
    @ViewBuilder private var putOnGitHub: some View {
        Button { gitFailure = nil; confirmGitPond = true } label: {
            Text(gitPondBusy ? FirstPondJourney.puttingOnGitHub : FirstPondJourney.putOnGitHub).lineLimit(1).fixedSize()
        }
        .buttonStyle(SecondaryButtonStyle()).disabled(gitPondBusy || !ponds.freshness(pond).canWrite).help(FirstPondJourney.gitPondHelp)
    }

    private func gitFailureLine(_ sentence: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(verbatim: sentence).font(Typo.footnote).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            Button("Try again") { gitFailure = nil; confirmGitPond = true }.buttonStyle(.borderless).font(Typo.footnote)
        }
    }

    // MARK: Needs you

    private func needsYou(_ items: [PondDashboardNeedsYouItem], ducks: PondDuckSections, joins: [JoinRequest]) -> some View {
        PondSection("Needs you") {
            VStack(spacing: 8) {
                ForEach(items) { item in
                    switch item.kind {
                    case .join(let requestId):
                        if let pond, let join = joins.first(where: { $0.id == requestId }) { JoinRequestCard(pond: pond, join: join) }
                    default:
                        PondNeedsYouRow(
                            item: item, open: { openNeeds(item, ducks: ducks) }, act: { act($0, on: item) },
                            decideStart: { approve in decideStart(item, approve: approve) })
                    }
                }
            }
        }
    }

    /// Open goes to the Duck, or for a Task to the Room, where its card is.
    private func openNeeds(_ item: PondDashboardNeedsYouItem, ducks: PondDuckSections) {
        if case .duck(let rowId) = item.kind, let row = (ducks.onDuty + ducks.offDuty).first(where: { $0.id == rowId }) { open(row); return }
        model.applyCentre(pond: key) { $0.switchTo(.room) }
    }

    /// A Member's waiting Duck: Approve starts it on this Mac through the normal path, Decline tells the Room.
    private func decideStart(_ item: PondDashboardNeedsYouItem, approve: Bool) {
        guard case .startApproval(let requestId) = item.kind, let pondId = pond?.id else { return }
        Task { await ponds.decideStart(pond: pondId, request: requestId, approve: approve) }
    }

    private func act(_ action: RoomTaskAction, on item: PondDashboardNeedsYouItem) {
        guard let room else { return }
        switch item.kind {
        case .taskApproval(let id): Task { await room.act(jobId: id, action, title: item.title, host: model.nativeHost) }
        default: break
        }
    }

    // MARK: Ducks

    private var emptyGuide: some View {
        VStack(spacing: 14) {
            ThreadDuckView(id: key, size: 56).accessibilityHidden(true)
            Text(verbatim: PondDashboardBlocks.emptySentence(role: role)).font(Typo.body).foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .padding(32).frame(maxWidth: .infinity)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    private func ducksBlock(_ ducks: PondDuckSections, blocks: PondDashboardBlocks) -> some View {
        let members = detail?.members ?? []
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Ducks").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Text(verbatim: "\(ducks.onDuty.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    .accessibilityLabel("\(ducks.onDuty.count) ducks on duty")
                Spacer(minLength: 0)
            }
            if blocks.ducks {
                VStack(spacing: 0) {
                    ForEach(ducks.onDuty) { r in PondChatRowView(row: r, members: members, open: open) }
                }
                .padding(.vertical, Space.xs).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
            if blocks.offDuty { offDuty(ducks.offDuty, members: members) }
        }
    }

    /// Off duty is folded at the end until asked for.
    private func offDuty(_ rows: [PondChatRow], members: [FlockMember]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(Motion.standard) { offDutyOpen.toggle() } } label: {
                HStack(spacing: 8) {
                    Lucide(offDutyOpen ? .chevronDown : .chevronRight, size: 12, color: Theme.subtle).frame(width: 18)
                    Text(verbatim: "Off duty \u{00B7} \(rows.count)").font(Typo.label).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand().accessibilityAddTraits(.isButton)
            if offDutyOpen {
                VStack(spacing: 0) {
                    ForEach(rows) { r in PondChatRowView(row: r, members: members, open: open) }
                }
                .padding(.vertical, Space.xs).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
        }
    }

    // MARK: Latest in the Room

    private func latestBlock(_ lines: [PondLatestLine]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("Latest in the Room").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Button("Open the Room") { model.applyCentre(pond: key) { $0.switchTo(.room) } }.buttonStyle(.borderless).font(Typo.footnote)
            }
            Button { model.applyCentre(pond: key) { $0.switchTo(.room) } } label: {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(lines) { l in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(verbatim: l.author).font(Typo.footnote.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: l.text).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                            Spacer(minLength: 8)
                            Text(verbatim: RelativeAge.short(l.at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                        }
                    }
                }
                .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand().accessibilityLabel("Latest in the Room. Opens the Room")
        }
    }

    // MARK: Opening and starting

    private func open(_ r: PondChatRow) {
        if let tab = r.local {
            model.openFromPond(tab, pond: key, page: .dashboard)
        } else if let p = pond, let id = r.pondThread {
            AppModel.shared.openPond(.thread(project: key, pondId: p.id, threadId: id))
        }
    }

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
        // The New duck page opens over the Pond it was started from, so Esc and Cancel return there. Leaving the Pond
        // first (closePondPage) made the open chat or the Dashboard the place to return to.
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
}

/// One thing waiting on the person: an amber edge when it needs a decision, the title and one line, and what can be done
/// (Open for a Duck or a blocked Task, Approve and Decline for a Member's Task). A Member's own waiting Task is words only.
private struct PondNeedsYouRow: View {
    let item: PondDashboardNeedsYouItem
    let open: () -> Void
    let act: (RoomTaskAction) -> Void
    let decideStart: (Bool) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if item.needsDecision { Lucide(.triangleAlert, size: 14, color: Theme.warning).accessibilityHidden(true) }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(2)
                Text(verbatim: item.line).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 8)
            switch item.kind {
            case .duck, .taskBlocked:
                Button("Open", action: open).buttonStyle(SecondaryButtonStyle())
            case .taskApproval:
                Button("Decline") { act(.drop) }.buttonStyle(SecondaryButtonStyle())
                Button("Approve") { act(.approve) }.buttonStyle(PondPrimaryButtonStyle())
            case .startApproval:
                Button("Decline") { decideStart(false) }.buttonStyle(SecondaryButtonStyle())
                Button("Approve") { decideStart(true) }.buttonStyle(PondPrimaryButtonStyle())
            case .taskWaiting, .startWaiting, .join: EmptyView()
            }
        }
        .padding(.leading, 16).padding(.trailing, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(alignment: .leading) { if item.needsDecision { Rectangle().fill(Theme.warning).frame(width: 3) } }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .contain)
    }
}
