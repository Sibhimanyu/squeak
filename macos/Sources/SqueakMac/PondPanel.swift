import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the Pond panel: the right panel's default content. Soft cards, no borders, no mono chips; every
// section with nothing to show is left out. What it says is decided in SqueakMacCore (`PondPanel.swift`).

struct PondPanel: View {
    let session: HostSession
    /// Opens the Code view, on Changes.
    var showChanges: () -> Void
    @Environment(AppModel.self) private var model

    private var native: Bool { session.source == .squeak }
    private var title: String { model.workbenchTitle(session) }

    private var pondThreads: [HostSession] {
        model.sidebarTree.place(of: session.key)?.project.workspaces.flatMap(\.chats) ?? [session]
    }

    private func fact(_ s: HostSession) -> PondThreadFact {
        PondThreadFact(
            key: s.key, title: model.workbenchTitle(s), state: s.state, lastActivityAt: s.lastActivityAt,
            startedAt: s.key == session.key && native ? model.native.info?.createdAt : nil)
    }

    private var facts: [PondThreadFact] { pondThreads.map(fact) }
    private var modelName: String? { native ? model.native.info.map { ModelNames.label($0.model, in: model.chatModels) } : model.chatExtras?.model }
    private var changes: DaemonChanges? { model.changesStore(for: session.key.hostSessionId).changes }
    private var changedLine: String? {
        guard let c = changes else { return nil }
        return PondSentence.changed(files: c.files.count, added: c.files.reduce(0) { $0 + $1.added }, removed: c.files.reduce(0) { $0 + $1.removed })
    }

    /// The pond this thread's project shares, when the host has one (Ponds/PondsModel.swift).
    private var pondDetail: PondsDetailRef? {
        guard let name = model.sidebarTree.place(of: session.key)?.project.name, let d = PondsModel.shared.detail(named: name) else { return nil }
        return PondsDetailRef(detail: d)
    }

    /// Activity: only what the sidebar and thread status do not already say (SqueakMacCore `PondActivity`).
    private var activity: [PondRipple] {
        var prs: [PondPullRequestFact] = []
        if let pr = model.gitStatus(session)?.pr, pr.state != .closed {
            prs = [PondPullRequestFact(number: pr.number, merged: pr.state == .merged, at: session.lastActivityAt, threadTitle: title)]
        }
        let local = PondRipples.build(threads: [], pullRequests: prs)
        let remote = PondRippleFeed.build(pondDetail?.detail.ripples ?? [])
        return PondActivity.filter(Array((local + remote).sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }.prefix(PondRipples.cap)))
    }

    @State private var activityOpen = false
    @State private var allThreads = false

    var body: some View {
        let needs = PondOrdering.needsYou(facts)
        let others = PondOrdering.others(facts, excluding: session.key)
        let feed = activity
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                thisThread
                if let line = PondMeta.strip(files: changes?.files.count ?? 0, added: changes?.files.reduce(0) { $0 + $1.added } ?? 0, removed: changes?.files.reduce(0) { $0 + $1.removed } ?? 0) { changesStrip(line) }
                people
                if !needs.isEmpty || !joinRequests.isEmpty { needsYou(needs) }
                if !others.isEmpty { otherThreads(others) }
                if !feed.isEmpty { activityFold(feed) }
            }
            .padding(Space.m)
        }
    }

    // MARK: Pieces

    private func section<V: View>(_ name: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: name).font(Typo.label).foregroundStyle(Theme.muted)
            content()
        }
    }

    private func card<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        content().padding(Space.m).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    /// Join requests an owner has to answer: they wait on a person like any thread does.
    private var joinRequests: [JoinRequest] {
        guard let d = pondDetail?.detail, d.myRole.canApproveJoins else { return [] }
        return d.joins
    }

    /// The thread's title and one meta line; "started by" / "runs on" appear only when not you / not this Mac.
    private var thisThread: some View {
        let me = pondDetail?.detail.members.first { $0.you }
        let starter = pondDetail?.detail.threads.first { $0.sessionId == session.key.hostSessionId || $0.id == session.key.hostSessionId }
        let foreign = starter.flatMap { t in me.map { t.starter != $0.id } } ?? false
        let metaText = PondMeta.line(
            agentName: SessionText.agentName(session.agent) ?? "Agent", model: modelName, state: session.state,
            startedAt: native ? model.native.info?.createdAt : nil, lastActivityAt: session.lastActivityAt, now: Date(),
            startedBy: foreign ? starter?.starterName : nil, runsOn: foreign ? starter?.nest : nil)
        return VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                Text(verbatim: title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(2)
                Spacer(minLength: 0)
                MarkSlot(mark: model.mark(for: session))
            }
            Text(verbatim: metaText).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func changesStrip(_ line: String) -> some View {
        Button(action: showChanges) {
            HStack(spacing: Space.s) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                Text("Code").font(Typo.meta).foregroundStyle(Theme.muted)
                Lucide(.chevronRight, size: 12, color: Theme.muted)
            }
            .padding(.horizontal, Space.m).padding(.vertical, Space.s).frame(maxWidth: .infinity)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var agentMembers: [PondMember] {
        PondPresence.members(person: NSFullUserName(), agent: session.agent, agentName: SessionText.agentName(session.agent), model: modelName)
    }

    /// A row of overlapping faces (you, the agent, the others) and a small invite button; the full list only when
    /// the pond has people other than you, three rows and "+N".
    @ViewBuilder private var people: some View {
        let detail = pondDetail?.detail
        let flock = detail.map { PondFlock.ordered($0.members, presence: $0.presence) } ?? []
        let others = flock.filter { !$0.you }
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(spacing: 0) {
                let local: [PondMember] = detail == nil ? agentMembers : agentMembers.filter { $0.kind == .agent }
                let total = flock.count + local.count
                let plan = PondFaces.overflow(total: total)
                let faces: [AnyView] = flock.map { m in
                    let online = detail.map { PondFlock.isOnline(m, presence: $0.presence) }
                    return AnyView(FlockAvatar(member: m, online: online ?? false, size: 26)
                        .help(PondFaces.tooltip(name: m.you ? "\(m.name) (you)" : m.name, role: m.role == .member ? nil : m.role.word, online: online)))
                } + local.map { m in AnyView(PondAvatar(member: m).help(PondFaces.tooltip(name: m.name, role: m.detail, online: nil))) }
                ForEach(0..<plan.shown, id: \.self) { i in
                    faces[i].overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2)).padding(.leading, i == 0 ? 0 : -8)
                }
                if plan.more > 0 {
                    Text(verbatim: "+\(plan.more)").font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, Space.s)
                }
                if let d = detail, d.myRole.canInvite {
                    Button { PondsModel.shared.startInvite(pondId: d.pond.id, account: model.account) } label: {
                        Lucide(.plus, size: 12, color: Theme.muted).frame(width: 26, height: 26).background(Theme.surface, in: Circle())
                    }
                    .buttonStyle(.plain).help("Invite someone").accessibilityLabel("Invite").padding(.leading, Space.s)
                }
                Spacer(minLength: 0)
            }
            if let d = detail, PondFaces.showsList(peopleOtherThanYou: others.count) {
                let rows = PondFaces.rows(total: others.count)
                ForEach(others.prefix(rows.shown)) { m in
                    HStack(spacing: Space.s) {
                        FlockAvatar(member: m, online: PondFlock.isOnline(m, presence: d.presence), size: 24)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: m.name).font(Typo.body).foregroundStyle(Theme.ink)
                            Text(verbatim: PondFlock.line(for: m, presence: d.presence, threads: d.threads)).font(Typo.meta).foregroundStyle(Theme.muted)
                        }
                        Spacer(minLength: 0)
                    }
                }
                if rows.more > 0 { Text(verbatim: "+\(rows.more) more").font(Typo.meta).foregroundStyle(Theme.muted) }
            }
        }
    }

    private func needsYou(_ list: [PondThreadFact]) -> some View {
        section("Needs you") {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(joinRequests) { j in joinRequest(j) }
                ForEach(list, id: \.key) { f in
                    if f.key == session.key, native, let card = model.native.card {
                        NativeNeedsYouCard(session: session, card: card, focusComposer: {})
                    } else if f.key == session.key, let display = model.askCardDisplay(for: session.key) {
                        AskCard(
                            ask: display.ask, framed: true, canSend: model.isConnected && display.phase == .live,
                            onSend: { form in await model.answer(form, for: session.key) }, result: display.outcome,
                            answeredElsewhere: display.phase == .answeredElsewhere)
                    } else if let s = pondThreads.first(where: { $0.key == f.key }) {
                        Button { model.select(s.key) } label: {
                            card {
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(verbatim: f.title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                                    Text(verbatim: s.pendingQuestion ?? "Waiting on you. Open it to answer.").font(Typo.footnote)
                                        .foregroundStyle(Theme.muted).lineLimit(2).multilineTextAlignment(.leading)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func joinRequest(_ j: JoinRequest) -> some View {
        card {
            VStack(alignment: .leading, spacing: Space.s) {
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
                HStack(spacing: Space.s) {
                    Button("Approve") { decide(j, true) }.buttonStyle(PondPrimaryButtonStyle())
                    Button("Deny") { decide(j, false) }.buttonStyle(SecondaryButtonStyle())
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(j.accessibilityLabel)
    }

    private func decide(_ j: JoinRequest, _ approve: Bool) {
        guard let id = pondDetail?.detail.pond.id else { return }
        Task { await PondsModel.shared.decideJoin(pond: id, request: j.id, approve: approve, role: j.role ?? .member) }
    }

    private func otherThreads(_ list: [PondThreadFact]) -> some View {
        let shown = allThreads ? list : Array(list.prefix(3))
        return section("Other threads in this pond") {
            VStack(spacing: 2) {
                ForEach(shown, id: \.key) { f in
                    if let s = pondThreads.first(where: { $0.key == f.key }) {
                        Button { model.select(s.key) } label: {
                            HStack(spacing: 6) {
                                Text(verbatim: f.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                                Spacer(minLength: 0)
                                MarkSlot(mark: model.mark(for: s), age: s.lastActivityAt)
                            }
                            .padding(.horizontal, Space.s).frame(height: Metrics.chatRow)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                if list.count > 3 {
                    Button("See all") {
                        if let name = model.sidebarTree.place(of: session.key)?.project.name { PondsModel.shared.route = .home(project: name) } else { allThreads = true }
                    }
                    .buttonStyle(.plain).font(Typo.meta).foregroundStyle(Theme.muted)
                    .padding(.horizontal, Space.s).padding(.top, 4).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    private func activityFold(_ list: [PondRipple]) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Button { activityOpen.toggle() } label: {
                HStack(spacing: 4) {
                    Lucide(activityOpen ? .chevronDown : .chevronRight, size: 11, color: Theme.muted)
                    Text(verbatim: PondActivity.label(count: list.count)).font(Typo.label).foregroundStyle(Theme.muted)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(PondActivity.label(count: list.count)).accessibilityValue(activityOpen ? "expanded" : "collapsed")
            if activityOpen {
                VStack(alignment: .leading, spacing: Space.s) {
                    ForEach(list) { r in
                        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                            Text(verbatim: r.sentence).font(Typo.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                            Text(verbatim: RelativeAge.short(r.at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                        }
                    }
                }
            }
        }
    }
}

/// A member's avatar: the person's coloured initial (a duck ring on you), or the agent's own mark.
struct PondAvatar: View {
    let member: PondMember

    var body: some View {
        if member.kind == .agent, let mark = AgentMark(agent: member.agent, size: 22) {
            mark.frame(width: 28, height: 28).background(Theme.selected, in: Circle())
        } else {
            Text(verbatim: member.initial).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                .frame(width: 28, height: 28).background(PondColour.avatar(member.colourIndex), in: Circle())
                .overlay { if member.detail == "You" { Circle().strokeBorder(PondColour.accent, lineWidth: 2) } }
        }
    }
}

/// A pond's detail, wrapped so the panel's optional reads stay short.
private struct PondsDetailRef { let detail: PondDetail }
