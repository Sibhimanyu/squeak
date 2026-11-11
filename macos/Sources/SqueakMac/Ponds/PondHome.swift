import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond home: clicking a project in the sidebar opens it here, not a chat. The workspaces with
// their chats and who is in each, the flock, Ripples. A project not in a pond yet still has a home, with its local threads
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
            case .settings(let project): PondSettingsView(project: project)
            case .thread(let project, let pondId, let threadId):
                PondThreadView(project: project, pondId: pondId, threadId: threadId).id(threadId)
            }
        }
    }
}

struct PondHomeView: View {
    let project: String
    @Environment(AppModel.self) private var model

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
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                header
                if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.muted) }
                if !joins.isEmpty { joinsGroup(joins) }
                PondWorkspacesView(layout: layout, members: detail?.members ?? [], open: open)
                PondFlockSection(project: project)
                if layout.isEmpty && joins.isEmpty {
                    Text(pond == nil ? PondWords.noThreads : "No threads yet. Start one, or share a thread from this Mac.")
                        .font(Typo.body).foregroundStyle(Theme.subtle)
                }
                ripples
            }
            .padding(.horizontal, Space.xl).padding(.bottom, Space.xl)
            .frame(maxWidth: 820, alignment: .leading).frame(maxWidth: .infinity)
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
            Button { ponds.route = .settings(project: project) } label: {
                Lucide(.settings, size: 16, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help(PondWords.settings).accessibilityLabel(PondWords.settings)
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
        let people = pond.map { detail?.members.count ?? $0.memberCount } ?? 1
        let n = layout.threadCount
        return "\(people) in the flock \u{00B7} \(n) \(n == 1 ? "thread" : "threads")"
    }

    /// Threads on this Mac not yet in the pond.
    private func shareMenu(_ p: PondSummary) -> some View {
        let shared = Set((detail?.threads ?? []).compactMap(\.sessionId))
        let candidates = localSessions.compactMap { s in model.hostId(s).map { (s, $0) } }.filter { !shared.contains($0.1) }
        return SqueakMenu("Share a thread") {
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

    // MARK: Threads

    private func joinsGroup(_ joins: [JoinRequest]) -> some View {
        PondSection(PondHomeGroup.needsYou.title) {
            VStack(spacing: Space.s) { ForEach(joins) { j in joinCard(j) } }
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

/// The pond's members and what each is in, with "Remove from pond…" for those who may: the pond home's Flock and the
/// settings page's, one view.
struct PondFlockSection: View {
    let project: String
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
        let members = detail.map { PondFlock.ordered($0.members, presence: presence) }
            ?? [FlockMember(id: "me", name: person, role: .owner, nest: "This Mac", online: true, you: true)]
        return PondSection("Flock") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 220), spacing: Space.s)], alignment: .leading, spacing: Space.s) {
                ForEach(members) { m in
                    HStack(spacing: Space.s) {
                        FlockAvatar(member: m, online: PondFlock.isOnline(m, presence: presence), size: 32)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: m.you ? "\(m.name) (you)" : m.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: (detail == nil ? "You \u{00B7} This Mac" : PondFlock.line(for: m, presence: presence, threads: detail?.threads ?? []))
                                + PondWorkspacesView.countSuffix(counts[m.id] ?? (m.you && detail == nil ? counts["me"] : nil)))
                                .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        if role.canRemoveMembers, !m.you, pond != nil {
                            SqueakMenu {
                                Button("Remove from pond\u{2026}", role: .destructive) { removing = m }
                            } label: { Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("More for \(m.name)")
                        }
                    }
                    .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                }
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
}
