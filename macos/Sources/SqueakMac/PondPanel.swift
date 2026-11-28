import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md "Pond tab, dashboard and Thread tab": the Pond tab is an ambient, compact, live glance at the pond of the
// thread on screen (or the open pond): who is here and what each is working on, what is going on now, what just
// happened. Managing the pond is the dashboard. Soft cards, no borders; a section with nothing to show is left out.
// What it says is decided in SqueakMacCore (`PondGlance`); this only draws.

struct PondPanel: View {
    let session: HostSession?
    @Environment(AppModel.self) private var model

    /// The pond: the open thread's, else the open pond page's.
    private var key: String? {
        if let session { return PondsModel.shared.key(of: session) }
        return PondsModel.shared.homeProject
    }

    private var localThreads: [HostSession] {
        if let session { return model.sidebarTree.place(of: session.key)?.project.workspaces.flatMap(\.chats) ?? [session] }
        guard let key else { return [] }
        let name = PondsModel.shared.name(key: key)
        return model.sidebarTree.projects.first { $0.name == name || $0.id == key }?.workspaces.flatMap(\.chats) ?? []
    }

    private func fact(_ s: HostSession) -> PondThreadFact {
        PondThreadFact(key: s.key, title: model.workbenchTitle(s), state: s.state, lastActivityAt: s.lastActivityAt, looping: s.isLoopingNow)
    }

    /// Ducks mode on a pond this Mac runs: the compact Pond tab (Open now, Recent, People); else today's look.
    private var compact: Bool { model.ducksMode && key.map { !PondsModel.shared.chrome(key: $0).isRemote } == true }

    private func open(key: String) -> [PondOpenDucks.Row] {
        let projectId = PondsModel.shared.entry(key)?.projectId
        let off = projectId.map { RoomRosterStore.shared.model(for: $0).closedSessions } ?? []  // the roster's list
        return PondOpenDucks.rows(
            model.duckRows(pond: key, fromPage: true), title: { model.workbenchTitle($0) }, looping: { $0.isLoopingNow },
            closed: { s in model.hostId(s).map(off.contains) ?? false })
    }

    var body: some View {
        if let key {
            let detail = PondsModel.shared.detail(key: key)
            let glance = PondGlance.build(detail: detail, local: localThreads.map(fact), youName: PondsModel.shared.myName)
            VStack(spacing: 0) {
                if compact { header(key: key) }
                ScrollView {
                    VStack(alignment: .leading, spacing: Space.l) {
                        if let pond = detail?.pond { PondFreshnessStrip(pond: pond) }
                        if compact {
                            openSection(open(key: key), key: key)
                            let recent = PondRecent.actionable(glance.recent)
                            if !recent.isEmpty { recentSection(recent) }
                            peopleRow(glance.people, key: key, detail: detail)
                        } else {
                            people(glance.people, detail: detail)
                            if !glance.now.isEmpty { nowSection(glance.now, key: key) }
                            if !glance.recent.isEmpty { recentSection(glance.recent) }
                        }
                    }
                    .padding(Space.m)
                }
                if !compact { footer(key: key, detail: detail) }
            }
            .heresayPrivate().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Text("Open a duck or a pond to see who is here.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    // MARK: Pieces

    private func section<V: View>(_ name: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: name).font(Typo.label).foregroundStyle(Theme.muted).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func people(_ list: [PondGlance.Person], detail: PondDetail?) -> some View {
        section("People") {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(list) { p in
                    HStack(spacing: Space.s) {
                        FlockAvatar(member: FlockMember(id: p.id, name: p.name, you: p.you), online: p.online, size: 26)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(verbatim: p.you ? "\(p.name) (you)" : p.name).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: p.line).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private func nowSection(_ rows: [PondGlance.NowRow], key: String) -> some View {
        section("Now") {
            VStack(spacing: 2) {
                ForEach(rows) { r in
                    Button { open(r, key: key) } label: {
                        HStack(spacing: 6) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: r.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                                Text(verbatim: "\(r.owner) \u{00B7} \(PondSentence.stateWord(r.state.session).lowercased())").font(Typo.meta)
                                    .foregroundStyle(Theme.muted).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            PondStateMark(state: r.state)
                        }
                        .padding(.horizontal, Space.s).padding(.vertical, 4).frame(minHeight: Metrics.chatRow)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens the duck")
                }
            }
        }
    }

    private func open(_ r: PondGlance.NowRow, key: String) {
        if let k = r.localKey { model.openFromPond(k, pond: key, page: RoomViewPref.shared.mode(for: key)); return }
        if let id = r.threadId, let pond = PondsModel.shared.pond(key: key) {
            AppModel.shared.openPond(.thread(project: key, pondId: pond.id, threadId: id))
        }
    }

    private func recentSection(_ list: [PondRipple]) -> some View {
        section("Recent") {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(list) { r in
                    HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                        Text(verbatim: r.sentence).font(Typo.footnote).foregroundStyle(Theme.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Text(verbatim: RelativeAge.short(r.at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                    }
                }
            }
        }
    }

    // MARK: Ducks mode

    private func header(key: String) -> some View {
        HStack(spacing: Space.s) {
            Text(verbatim: PondsModel.shared.name(key: key)).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
            Spacer(minLength: 0)
            Button("Open dashboard") { AppModel.shared.openPondHome(key) }.buttonStyle(QuietButtonStyle())
        }
        .padding(.horizontal, Space.m).padding(.top, Space.s)
    }

    private func openSection(_ rows: [PondOpenDucks.Row], key: String) -> some View {
        section("Open now") {
            if rows.isEmpty {
                Text("No duck is working right now.").font(Typo.body).foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 2) {
                    ForEach(rows) { r in
                        Button { model.openFromPond(r.key, pond: key, page: RoomViewPref.shared.mode(for: key)) } label: {
                            HStack(spacing: 6) {
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(verbatim: r.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                                    if let b = r.branch, !b.isEmpty { Text(verbatim: b).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1) }
                                }
                                Spacer(minLength: 0)
                                Text(verbatim: r.needsYou ? "Needs you" : "Working").font(Typo.meta).foregroundStyle(r.needsYou ? Theme.ink : Theme.muted)
                            }
                            .padding(.horizontal, Space.s).padding(.vertical, 4).frame(minHeight: Metrics.chatRow)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("Opens the duck")
                    }
                }
            }
        }
    }

    /// Member avatars in one row with Invite beside them.
    private func peopleRow(_ list: [PondGlance.Person], key: String, detail: PondDetail?) -> some View {
        let pond = detail?.pond ?? PondsModel.shared.pond(key: key)
        // Every Pond this person owns can invite, a local one with no Ducks included: the invite shares it first.
        let canInvite = detail.map { $0.can.allows(.invite) } ?? (pond?.mayInvite(detailRole: nil) ?? false)
        return section("People") {
            HStack(spacing: Space.s) {
                HStack(spacing: -6) {
                    ForEach(list.prefix(6)) { p in
                        FlockAvatar(member: FlockMember(id: p.id, name: p.name, you: p.you), online: p.online, size: 26)
                    }
                }
                if list.count > 6 { Text(verbatim: "+\(list.count - 6)").font(Typo.meta).foregroundStyle(Theme.muted) }
                Spacer(minLength: 0)
                if canInvite, let pond { Button("Invite") { PondsModel.shared.startInvite(pondId: pond.id, account: model.account) }.buttonStyle(QuietButtonStyle()) }
            }
        }
    }

    private func footer(key: String, detail: PondDetail?) -> some View {
        HStack(spacing: Space.s) {
            if let d = detail, d.can.allows(.invite) {
                Button("Invite") { PondsModel.shared.startInvite(pondId: d.pond.id, account: model.account) }.buttonStyle(SecondaryButtonStyle())
            } else if detail == nil, let pond = PondsModel.shared.pond(key: key) {
                Button("Invite") { PondsModel.shared.startInvite(pondId: pond.id, account: model.account) }.buttonStyle(SecondaryButtonStyle())
            }
            Button("Open dashboard") { AppModel.shared.openPondHome(key) }.buttonStyle(SecondaryButtonStyle())
            Spacer(minLength: 0)
        }
        .padding(Space.m)
    }
}
