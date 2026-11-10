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
    private var modelName: String? { native ? model.native.info?.model : model.chatExtras?.model }
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

    private var ripples: [PondRipple] {
        var prs: [PondPullRequestFact] = []
        if let pr = model.gitStatus(session)?.pr, pr.state != .closed {
            prs = [PondPullRequestFact(number: pr.number, merged: pr.state == .merged, at: session.lastActivityAt, threadTitle: title)]
        }
        let local = PondRipples.build(
            threads: facts, pullRequests: prs,
            changed: changes.map { (title, $0.files.count, session.lastActivityAt) })
        // The pond's own Ripples (who started, joined, finished) sit with this thread's, newest first.
        let remote = PondRippleFeed.build(pondDetail?.detail.ripples ?? [])
        return remote.isEmpty ? local : Array((local + remote).sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }.prefix(PondRipples.cap))
    }

    var body: some View {
        let needs = PondOrdering.needsYou(facts)
        let others = PondOrdering.others(facts, excluding: session.key)
        let feed = ripples
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                flock
                thisThread
                if !needs.isEmpty || !joinRequests.isEmpty { needsYou(needs) }
                if !others.isEmpty { otherThreads(others) }
                if !feed.isEmpty { rippleFeed(feed) }
                if let line = changedLine { whatChanged(line) }
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

    private var flock: some View {
        section("Who\u{2019}s here") {
            card {
                VStack(alignment: .leading, spacing: Space.s) {
                    // With a pond, the real flock: who is online, who is typing, what they look at.
                    if let d = pondDetail?.detail {
                        ForEach(PondFlock.ordered(d.members, presence: d.presence)) { m in
                            HStack(spacing: Space.s) {
                                FlockAvatar(member: m, online: PondFlock.isOnline(m, presence: d.presence), size: 28)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(verbatim: m.you ? "\(m.name) (you)" : m.name).font(Typo.body).foregroundStyle(Theme.ink)
                                    Text(verbatim: PondFlock.line(for: m, presence: d.presence, threads: d.threads)).font(Typo.meta).foregroundStyle(Theme.muted)
                                }
                                Spacer(minLength: 0)
                            }
                        }
                    }
                    ForEach(PondPresence.members(
                        person: NSFullUserName(), agent: session.agent, agentName: SessionText.agentName(session.agent), model: modelName)
                        .filter { pondDetail == nil || $0.kind == .agent }) { m in
                        HStack(spacing: Space.s) {
                            PondAvatar(member: m)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: m.name).font(Typo.body).foregroundStyle(Theme.ink)
                                if let d = m.detail { Text(verbatim: d).font(Typo.meta).foregroundStyle(Theme.muted) }
                            }
                            Spacer(minLength: 0)
                        }
                    }
                    if let d = pondDetail?.detail, d.myRole.canInvite {
                        Button("Invite") { PondsModel.shared.startInvite(pondId: d.pond.id, account: model.account) }
                            .buttonStyle(SecondaryButtonStyle())
                    }
                }
            }
        }
    }

    private var thisThread: some View {
        let now = Date()
        return section("This thread") {
            card {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: Space.s) {
                        Text(verbatim: title).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(2)
                        Spacer(minLength: 0)
                        MarkSlot(mark: model.mark(for: session))
                    }
                    detail("Started by", NSFullUserName().isEmpty ? "You" : NSFullUserName())
                    detail("Runs on", "This Mac")
                    detail("Agent", [SessionText.agentName(session.agent), modelName].compactMap { $0 }.joined(separator: " \u{00B7} "))
                    detail(
                        PondSentence.stateWord(session.state),
                        PondSentence.timing(state: session.state, startedAt: native ? model.native.info?.createdAt : nil, lastActivityAt: session.lastActivityAt, now: now) ?? "")
                }
            }
        }
    }

    @ViewBuilder private func detail(_ label: String, _ value: String) -> some View {
        if !value.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                Text(verbatim: label).font(Typo.meta).foregroundStyle(Theme.muted).frame(width: 70, alignment: .leading)
                Text(verbatim: value).font(Typo.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
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
        section("Other threads in this pond") {
            VStack(spacing: 2) {
                ForEach(list, id: \.key) { f in
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
            }
        }
    }

    private func rippleFeed(_ list: [PondRipple]) -> some View {
        section("Ripples") {
            card {
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

    private func whatChanged(_ line: String) -> some View {
        section("What changed") {
            Button(action: showChanges) {
                card {
                    HStack {
                        Text(verbatim: line).font(Typo.body).foregroundStyle(Theme.ink)
                        Spacer(minLength: 0)
                        Text("Open in Code").font(Typo.meta).foregroundStyle(Theme.muted)
                        Lucide(.chevronRight, size: 12, color: Theme.muted)
                    }
                }
            }
            .buttonStyle(.plain)
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
