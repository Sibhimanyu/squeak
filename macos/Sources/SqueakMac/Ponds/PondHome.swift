import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond home: clicking a project in the sidebar opens it here, not a chat. The flock, the threads
// as cards (Needs you, Working, Done), Ripples. A project not in a pond yet still has a home, with its local threads
// and "Share this pond". Soft cards, no borders; what it says is decided in SqueakMacCore (`PondLogic.swift`).

/// Chooses what the centre shows for a pond route.
struct PondRouteView: View {
    let route: PondRoute
    let sidebarHidden: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                // The sidebar's toggle (PaneToggleOverlay) sits here while the sidebar is closed.
                if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding + PaneToggle.size) }
                Spacer(minLength: 0)
            }
            .frame(height: Metrics.header).background(WindowDragArea())
            switch route {
            case .home(let project): PondHomeView(project: project)
            case .thread(let project, let pondId, let threadId):
                PondThreadView(project: project, pondId: pondId, threadId: threadId).id(threadId)
            }
        }
    }
}

struct PondHomeView: View {
    let project: String
    @Environment(AppModel.self) private var model
    @State private var removing: FlockMember?

    private var ponds: PondsModel { .shared }
    private var pond: PondSummary? { ponds.pond(named: project) }
    private var detail: PondDetail? { pond.flatMap { ponds.details[$0.id] } }
    private var native: NativeProject? { NativeWorkspaceMaking.project(named: project, in: model.native.projects) }
    private var localSessions: [HostSession] {
        model.sidebarTree.projects.first { $0.name.caseInsensitiveCompare(project) == .orderedSame }?.workspaces.flatMap(\.chats) ?? []
    }
    private var person: String { NSFullUserName().isEmpty ? "You" : NSFullUserName() }
    private var role: PondRole { detail?.myRole ?? pond?.role ?? .owner }

    private var threads: [PondHomeThread] {
        if let detail {
            return PondHomeThreads.fromPond(detail) { id in localSessions.first { model.hostId($0) == id }?.key }
        }
        let facts = localSessions.map {
            PondThreadFact(key: $0.key, title: model.workbenchTitle($0), state: $0.state, lastActivityAt: $0.lastActivityAt)
        }
        return PondHomeThreads.fromLocal(facts, agents: Dictionary(localSessions.compactMap { s in s.agent.map { (s.key, $0) } }, uniquingKeysWith: { a, _ in a }), person: person)
    }

    var body: some View {
        let sections = PondHomeThreads.sections(threads)
        let joins = role.canApproveJoins ? (detail?.joins ?? []) : []
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                header
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.muted) }
                flock
                if sections.isEmpty && joins.isEmpty {
                    Text(pond == nil ? PondWords.noThreads : "No threads yet. Start one, or share a thread from this Mac.")
                        .font(Typo.body).foregroundStyle(Theme.subtle)
                }
                if !joins.isEmpty && sections.first?.group != .needsYou { group(.needsYou, joins: joins, threads: []) }
                ForEach(sections) { s in group(s.group, joins: s.group == .needsYou ? joins : [], threads: s.threads) }
                ripples
            }
            .padding(.horizontal, Space.xl).padding(.bottom, Space.xl)
            .frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity)
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

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: Space.m) {
            PondTile(name: project, pondId: pond?.id, size: 44, onTint: pond != nil)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: project).font(Typo.title).foregroundStyle(Theme.ink).lineLimit(1)
                Text(verbatim: subtitle).font(Typo.footnote).foregroundStyle(Theme.ink)
                if pond?.local ?? true {
                    Text(PondWords.onlyThisMac).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                if let pond, !pond.local, case .shareOnly(let why) = PondStartThread.offer(for: pond) {
                    Text(verbatim: why).font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: Space.m)
            if role.canInvite, let p = pond {
                Button("Invite") { ponds.startInvite(pondId: p.id, account: model.account) }.buttonStyle(SecondaryButtonStyle())
            }
            if let p = pond, !p.local, role.canMessage { shareMenu(p) }
            if pond == nil || pond?.local == true || pond.map({ PondStartThread.offer(for: $0) }) == .start {
                Button("Start a thread") { startThread() }.buttonStyle(PondPrimaryButtonStyle())
            }
        }
        .padding(Space.m)
        .background(PondColour.tint(pond?.id), in: RoundedRectangle(cornerRadius: Radius.panel, style: .continuous))
        .padding(.top, Space.s)
    }

    private var subtitle: String {
        guard let pond else { return "1 in the flock \u{00B7} 0 threads" }
        let people = detail?.members.count ?? pond.memberCount
        let n = detail?.threads.count ?? pond.threadCount
        return "\(people) in the flock \u{00B7} \(n) \(n == 1 ? "thread" : "threads")"
    }

    /// Threads on this Mac not yet in the pond.
    private func shareMenu(_ p: PondSummary) -> some View {
        let shared = Set((detail?.threads ?? []).compactMap(\.sessionId))
        let candidates = localSessions.compactMap { s in model.hostId(s).map { (s, $0) } }.filter { !shared.contains($0.1) }
        return Menu("Share a thread") {
            ForEach(candidates, id: \.1) { s, id in
                Button(model.workbenchTitle(s)) { Task { await ponds.share(pond: p.id, sessionId: id) } }
            }
        }
        .menuStyle(.button).buttonStyle(SecondaryButtonStyle()).fixedSize()
        .disabled(candidates.isEmpty)
        .help(candidates.isEmpty ? "Every thread on this Mac is already in the pond" : "Show one of this Mac\u{2019}s threads to the flock")
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

    // MARK: Flock

    private var flock: some View {
        let presence = detail?.presence ?? []
        let members = detail.map { PondFlock.ordered($0.members, presence: presence) }
            ?? [FlockMember(id: "me", name: person, role: .owner, nest: "This Mac", online: true, you: true)]
        return PondSection("Flock") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: Space.s)], alignment: .leading, spacing: Space.s) {
                ForEach(members) { m in
                    HStack(spacing: Space.s) {
                        FlockAvatar(member: m, online: PondFlock.isOnline(m, presence: presence), size: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: m.you ? "\(m.name) (you)" : m.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: detail == nil ? "You \u{00B7} This Mac" : PondFlock.line(for: m, presence: presence, threads: detail?.threads ?? []))
                                .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if role.canRemoveMembers, !m.you, pond != nil {
                            Menu {
                                Button("Remove from pond\u{2026}", role: .destructive) { removing = m }
                            } label: { Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("More for \(m.name)")
                        }
                    }
                    .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                }
            }
        }
    }

    // MARK: Threads

    private func group(_ g: PondHomeGroup, joins: [JoinRequest], threads: [PondHomeThread]) -> some View {
        PondSection(g.title) {
            VStack(spacing: Space.s) {
                ForEach(joins) { j in joinCard(j) }
                ForEach(threads) { t in threadCard(t) }
            }
        }
    }

    private func joinCard(_ j: JoinRequest) -> some View {
        HStack(spacing: Space.s) {
            FlockAvatar(member: FlockMember(id: j.id, name: j.name), online: false, size: 32)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: "\(j.displayName) wants to join").font(Typo.label).foregroundStyle(Theme.ink)
                if let email = j.verifiedEmail {
                    HStack(spacing: 4) {
                        Text(verbatim: email).textSelection(.enabled)
                        Text(verbatim: "·")
                        Image(systemName: "checkmark.seal.fill").imageScale(.small)
                        Text("Verified")
                    }
                    .font(Typo.meta).foregroundStyle(Theme.muted)
                }
                Text(verbatim: "Joining as \((j.role ?? .member).word.lowercased()). Approve only people you know.").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
            Button("Deny") { decide(j, approve: false) }.buttonStyle(SecondaryButtonStyle())
            Button("Approve") { decide(j, approve: true) }.buttonStyle(PondPrimaryButtonStyle())
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(j.accessibilityLabel)
    }

    private func decide(_ j: JoinRequest, approve: Bool) {
        guard let p = pond else { return }
        Task { await ponds.decideJoin(pond: p.id, request: j.id, approve: approve, role: j.role ?? .member) }
    }

    private func threadCard(_ t: PondHomeThread) -> some View {
        Button { open(t) } label: {
            HStack(spacing: Space.m) {
                FlockAvatar(member: FlockMember(id: t.starter ?? t.starterName, name: t.starterName), online: false, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: t.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: [t.starterName, t.nest, t.isPrivate ? "Private" : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                        .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 0)
                if let a = AgentMark(agent: t.agent, size: 16) { a.help(SessionText.agentName(t.agent) ?? "") }
                PondStateMark(state: t.state)
                if let at = t.updatedAt {
                    Text(verbatim: RelativeAge.short(at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                }
            }
            .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(t.title), \(PondSentence.stateWord(t.state.session)), started by \(t.starterName)")
    }

    private func open(_ t: PondHomeThread) {
        if let key = t.local {
            ponds.route = nil
            model.select(key)
        } else if let p = pond, let id = t.pondThread {
            ponds.route = .thread(project: project, pondId: p.id, threadId: id)
        }
    }

    // MARK: Ripples

    @ViewBuilder private var ripples: some View {
        let feed = PondRippleFeed.build(detail?.ripples ?? [])
        if !feed.isEmpty {
            PondSection("Ripples") {
                VStack(alignment: .leading, spacing: Space.s) {
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
    let content: Content
    init(_ title: String, @ViewBuilder _ content: () -> Content) { self.title = title; self.content = content() }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: title).font(Typo.label).foregroundStyle(Theme.muted)
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
                if online { Circle().fill(Theme.done).frame(width: size * 0.3, height: size * 0.3).overlay(Circle().strokeBorder(Theme.surface, lineWidth: 2)) }
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
        Text(String(name.prefix(1)).uppercased()).font(.system(size: size * 0.45, weight: .bold)).foregroundStyle(Theme.ink)
            .frame(width: size, height: size)
            .background(onTint ? Theme.surface : PondColour.tint(pondId), in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}
