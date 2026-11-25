import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md "Pond tab, dashboard and Thread tab": the Thread tab covers the one thread open in the centre, live: who
// is in it, what is running, and its controls. What it says is decided in `ThreadGlance`.

struct ThreadPanel: View {
    let session: HostSession?
    @Environment(AppModel.self) private var model

    var body: some View {
        if let session {
            content(session).heresayPrivate().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack {
                Text("Open a duck to see who is in it and what it is doing.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    private func native(_ s: HostSession) -> Bool { s.source == .squeak }
    private func modelName(_ s: HostSession) -> String? {
        native(s) ? model.native.info.map { ModelNames.label($0.model, in: model.chatModels) } : model.chatExtras?.model
    }

    private func pondThread(_ s: HostSession, _ d: PondDetail?) -> PondThread? {
        d?.threads.first { $0.sessionId == s.key.hostSessionId || $0.id == s.key.hostSessionId }
    }

    @ViewBuilder private func content(_ s: HostSession) -> some View {
        let key = PondsModel.shared.key(of: s)
        let detail = key.flatMap { PondsModel.shared.detail(key: $0) }
        let thread = pondThread(s, detail)
        let changes = model.changesStore(for: s.key.hostSessionId).changes
        let glance = ThreadGlance.build(
            agentName: SessionText.agentName(s.agent), model: modelName(s), state: s.state, you: NSFullUserName(),
            thread: thread, members: detail?.members ?? [], presence: detail?.presence ?? [], meId: detail?.meMember?.id,
            helpers: model.ducklings(for: s)?.items ?? [],
            queued: native(s) && model.native.key == s.key ? model.native.pending.stackCards.map(\.text) : [],
            files: changes?.files ?? [])
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                header(s, glance)
                needsYou(s)
                if glance.people.count > 0 { who(glance) }
                if glance.hasRunning || !glance.helpers.isEmpty { running(glance, s) }
                controls(s, key: key, detail: detail, thread: thread)
            }
            .padding(Space.m)
        }
    }

    // MARK: Pieces

    private func section<V: View>(_ name: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text(verbatim: name).font(Typo.label).foregroundStyle(Theme.muted).accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func header(_ s: HostSession, _ g: ThreadGlance) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                Text(verbatim: model.workbenchTitle(s)).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(2)
                Spacer(minLength: 0)
                MarkSlot(mark: model.mark(for: s))
            }
            Text(verbatim: [g.statusWord, g.agentLine].compactMap { $0 }.joined(separator: " \u{00B7} ")).font(Typo.meta).foregroundStyle(Theme.muted)
            if let line = g.changedLine {
                Button { NotificationCenter.default.post(name: .squeakShowCode, object: nil) } label: {
                    Text(verbatim: line).font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                .buttonStyle(.plain).help("Open Code")
            }
        }
    }

    /// What waits on the person here (it moved from the old Pond panel): the card that answers it.
    @ViewBuilder private func needsYou(_ s: HostSession) -> some View {
        if s.state == .blocked || s.isLoopingNow {
            section("Needs you") {
                if native(s), let card = model.native.card {
                    NativeNeedsYouCard(session: s, card: card, focusComposer: {}, compact: true)
                } else if let display = model.askCardDisplay(for: s.key) {
                    AskCard(
                        ask: display.ask, framed: true, canSend: model.isConnected && display.phase == .live,
                        onSend: { form in await model.answer(form, for: s.key) }, result: display.outcome,
                        answeredElsewhere: display.phase == .answeredElsewhere)
                } else {
                    Text(verbatim: s.loopingSentence ?? s.pendingQuestion ?? "Waiting on you. Answer it in the duck.").font(Typo.footnote).foregroundStyle(Theme.muted)
                }
                if s.isLoopingNow {
                    Button("Tell it to stop retrying") { Task { await model.stopRetrying(sessionKey: s.key.hostSessionId) } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.chatBusy)
                }
            }
        }
    }

    private func who(_ g: ThreadGlance) -> some View {
        section("Who") {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(g.people) { p in
                    HStack(spacing: Space.s) {
                        FlockAvatar(member: FlockMember(id: p.id, name: p.name, you: p.you), online: p.role == .watching, size: 24)
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

    private func running(_ g: ThreadGlance, _ s: HostSession) -> some View {
        section("Running") {
            VStack(alignment: .leading, spacing: Space.s) {
                ForEach(g.helpers) { h in
                    Button {
                        if !h.isShell { model.openDucklingAnywhere(DucklingRef(session: s.key, taskId: h.id)) }
                    } label: {
                    HStack(spacing: Space.s) {
                        Lucide(h.isShell ? .terminal : .users, size: 13, color: Theme.muted)
                        Text(verbatim: h.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 0)
                        Text(verbatim: h.status).font(Typo.meta).foregroundStyle(h.running ? Theme.ink : Theme.muted)
                    }
                    .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(h.isShell)
                    .help(h.isShell ? "" : "Open this duckling as a tab")
                }
                if !g.queued.isEmpty {
                    Text(verbatim: g.queued.count == 1 ? "1 message queued" : "\(g.queued.count) messages queued").font(Typo.meta).foregroundStyle(Theme.muted)
                    ForEach(Array(g.queued.enumerated()), id: \.offset) { _, text in
                        Text(verbatim: text).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                }
            }
        }
    }

    private func controls(_ s: HostSession, key: String?, detail: PondDetail?, thread: PondThread?) -> some View {
        section("Controls") {
            VStack(alignment: .leading, spacing: Space.s) {
                if native(s) {
                    HStack(spacing: Space.s) {
                        Text("Approvals").font(Typo.body).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                        if let mode = model.native.mode { ModeChip(mode: mode, onPick: { model.nativeSetMode(s, $0) }) }
                    }
                    HStack(spacing: Space.s) {
                        Text("Model").font(Typo.body).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                        NativeModelMenu(session: s)
                    }
                }
                if let t = thread, let d = detail, PondThreadRules.canTogglePrivate(starter: t.starter, me: d.meMember?.id) {
                    Toggle(isOn: Binding(get: { t.isPrivate }, set: { v in Task { await PondsModel.shared.setPrivate(pond: d.pond.id, thread: t.id, isPrivate: v) } })) {
                        Text(verbatim: PondThreadStatus.visibility(isPrivate: t.isPrivate)).font(Typo.body).foregroundStyle(Theme.muted)
                    }
                    .toggleStyle(.switch).controlSize(.small).help("Private: only you see this duck. Off: the pond sees it.")
                } else if thread == nil, native(s), let key, let pond = PondsModel.shared.pond(key: key), let id = model.hostId(s) {
                    SqueakMenu("Share with \(pond.name)") {
                        Button("Share with the pond") { Task { await PondsModel.shared.share(pond: pond.id, sessionId: id) } }
                        Button("Share (private)") { Task { await PondsModel.shared.share(pond: pond.id, sessionId: id, isPrivate: true) } }
                    }
                    .menuStyle(.button).buttonStyle(SecondaryButtonStyle()).fixedSize()
                }
            }
        }
    }
}
