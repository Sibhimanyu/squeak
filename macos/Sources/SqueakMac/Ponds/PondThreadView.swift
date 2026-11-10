import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, a thread from the pond: the normal transcript, driven by the host's `ThreadEvent`s (resumed from
// the last seq, read again on the stream's `changed`). Anyone may message, steer and answer; approving belongs to the
// starter on the starter's own Mac, and there is no stop here, because neither exists on the wire (docs/ponds.md).

struct PondThreadView: View {
    let project: String
    let pondId: String
    let threadId: String
    @Environment(AppModel.self) private var model
    @State private var events: [ThreadEvent] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var focusToken = 0
    @State private var typingTask: Task<Void, Never>?

    private var ponds: PondsModel { .shared }
    private var detail: PondDetail? { ponds.details[pondId] }
    private var thread: PondThread? { detail?.threads.first { $0.id == threadId } }
    private var members: [FlockMember] { detail?.members ?? [] }
    private var me: String? { detail?.meMember?.id ?? detail?.me?.id }
    private var role: PondRole { detail?.myRole ?? .viewer }
    private var rows: [ThreadRow] { ThreadTimeline.rows(events) }
    private var state: PondThreadState { ThreadTimeline.latestState(events) ?? PondThreadState(raw: thread?.state ?? "") }
    private var working: Bool { state == .working }
    private var starterName: String {
        guard let t = thread else { return "" }
        return t.starterName.isEmpty ? name(t.starter) : t.starterName
    }
    private func name(_ id: String?) -> String { members.first { $0.id == id }?.name ?? "" }

    var body: some View {
        VStack(spacing: 0) {
            header
            transcript
            composer
        }
        .task(id: ponds.changeTick[pondId] ?? 0) {
            // The stream's `changed` wakes this; the minute is the safety net.
            while !Task.isCancelled {
                await readEvents()
                try? await Task.sleep(for: .seconds(60))
            }
        }
        .onAppear { ponds.presence(pond: pondId, viewing: threadId, typing: false) }
        .onDisappear { typingTask?.cancel(); ponds.presence(pond: pondId, viewing: "", typing: false) }
    }

    private func readEvents() async {
        // Pages until the host has nothing after what is held.
        for _ in 0..<20 {
            guard let page = await ponds.events(pond: pondId, thread: threadId, after: ThreadTimeline.resumeSeq(events)), !page.events.isEmpty else { return }
            events = ThreadTimeline.merge(events, page.events)
            if page.lastSeq <= ThreadTimeline.resumeSeq(events) { return }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.m) {
            Button { ponds.route = .home(project: project) } label: {
                HStack(spacing: 4) {
                    Lucide(.chevronLeft, size: 14, color: Theme.muted)
                    Text(verbatim: project).font(Typo.body).foregroundStyle(Theme.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel("Back to \(project)")
            Text(verbatim: thread?.title.isEmpty == false ? thread!.title : "Thread").font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1)
            if let a = AgentMark(agent: thread?.agent, size: 16) { a }
            PondStateMark(state: state)
            Spacer(minLength: Space.m)
            let viewers = PondFlock.viewers(of: threadId, members: members, presence: detail?.presence ?? [], excluding: me)
            ForEach(viewers) { v in FlockAvatar(member: v, online: true, size: 22).help("\(v.name) is here") }
            Text(verbatim: [starterName.isEmpty ? nil : "Started by \(starterName)", thread?.nest].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " \u{00B7} "))
                .font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            if let t = thread, PondThreadRules.canTogglePrivate(starter: t.starter, me: me) {
                Toggle("Private", isOn: Binding(get: { thread?.isPrivate ?? false }, set: { v in Task { await ponds.setPrivate(pond: pondId, thread: threadId, isPrivate: v) } }))
                    .toggleStyle(.switch).controlSize(.small).font(Typo.body)
                    .help("Only you see a private thread")
            }
        }
        .padding(.horizontal, Space.l).frame(height: 40)
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(rows) { row in rowView(row).id(row.id) }
                    if rows.isEmpty { Text("Nothing in this thread yet.").font(Typo.body).foregroundStyle(Theme.subtle) }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.m)
                .frame(maxWidth: Metrics.workbenchColumn, alignment: .leading).frame(maxWidth: .infinity)
            }
            .onChange(of: rows.last?.id) { _, id in if let id { withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo(id, anchor: .bottom) } } }
        }
    }

    @ViewBuilder private func rowView(_ row: ThreadRow) -> some View {
        let agent = SessionText.agentName(thread?.agent) ?? "Agent"
        switch row {
        case .user(let id, let by, let text, let at):
            VStack(alignment: .trailing, spacing: 3) {
                if !name(by).isEmpty { Text(verbatim: by == me ? "You" : name(by)).font(Typo.meta).foregroundStyle(Theme.muted) }
                MessageView(message: ChatMessage(id: "pond-\(id)", role: .user, text: text, at: at), agentName: agent, canOpenHost: false, agentWorking: false)
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        case .agent(let id, let text, let at):
            MessageView(message: ChatMessage(id: "pond-\(id)", role: .assistant, text: text, at: at), agentName: agent, canOpenHost: false, agentWorking: false)
        case .steps(let id, let steps):
            TurnBlockView(block: TurnFolding.block(steps: steps, working: working && row.id == rows.last?.id), filesLine: nil).id("steps-\(id)")
        case .question(_, let requestId, let text, let options, let resolved):
            PondQuestionCard(pondId: pondId, threadId: threadId, requestId: requestId, text: text, options: options, resolved: resolved, me: me)
        case .approval(_, _, let label, let resolved):
            approval(label: label, resolved: resolved)
        case .changed(_, let files, let added, let removed):
            if let line = PondSentence.changed(files: files, added: added, removed: removed) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    /// Read-only: it is shown so people know why the thread waits, and answered by its starter on their own Mac.
    private func approval(label: String, resolved: Bool) -> some View {
        HStack(alignment: .top, spacing: Space.s) {
            Lucide(.triangleAlert, size: 14, color: resolved ? Theme.subtle : Theme.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: label).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: resolved ? "Resolved" : PondThreadRules.approvalLine(starterName: starterName, isStarter: thread?.starter == me))
                    .font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let line = PondFlock.typingLine(in: threadId, members: members, presence: detail?.presence ?? [], excluding: me) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.muted) }
            VStack(alignment: .leading, spacing: 4) {
                ComposerField(
                    text: $draft, sendKey: .returnSends, placeholder: PondThreadRules.composerPlaceholder(role: role, working: working),
                    isEnabled: role.canMessage && !sending, focusToken: focusToken,
                    onSend: { send(.queue) }, onCommandReturn: { send(.steer) })
                    .frame(height: 56)
                if role.canMessage, working {
                    Text("\u{21B5} queue \u{00B7} \u{2318}\u{21B5} steer").font(Typo.meta).foregroundStyle(Theme.subtle)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .padding(.horizontal, Space.l).padding(.bottom, Space.l).padding(.top, Space.s)
        .frame(maxWidth: Metrics.workbenchColumn).frame(maxWidth: .infinity)
        .onChange(of: draft.isEmpty) { _, empty in typing(!empty) }
    }

    private func send(_ key: ComposerKeyAction) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard role.canMessage, !text.isEmpty, !sending, let mode = ComposerKeys.mode(key) else { return }
        sending = true
        Task {
            if await ponds.send(pond: pondId, thread: threadId, text: text, mode: mode) != nil {
                draft = ""
                await readEvents()
            }
            sending = false
            focusToken += 1
        }
    }

    /// Typing is told to the flock while words are in the box, renewed before the host lets it lapse.
    private func typing(_ on: Bool) {
        typingTask?.cancel()
        ponds.presence(pond: pondId, viewing: threadId, typing: on)
        guard on else { return }
        typingTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                if !Task.isCancelled { ponds.presence(pond: pondId, viewing: threadId, typing: true) }
            }
        }
    }
}

/// A question another person's agent asks. Whoever starts answering holds it, and the rest see who.
struct PondQuestionCard: View {
    let pondId: String
    let threadId: String
    let requestId: String
    let text: String
    let options: [String]
    let resolved: Bool
    let me: String?
    @State private var answer = ""
    @State private var refusal: String?
    @State private var holdTask: Task<Void, Never>?
    @State private var sending = false
    private var ponds: PondsModel { .shared }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 3)) { ctx in
            let held = PondHolds.line(requestId, holds: ponds.details[pondId]?.holds ?? [], me: me, now: ctx.date)
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(alignment: .top, spacing: Space.s) {
                    Lucide(.messageCircleQuestionMark, size: 15, color: Theme.muted)
                    Text(verbatim: text).font(Typo.reading).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                if resolved {
                    Text("Answered").font(Typo.footnote).foregroundStyle(Theme.muted)
                } else {
                    if let line = held ?? refusal { Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted) }
                    if !options.isEmpty {
                        HStack(spacing: Space.s) {
                            ForEach(options, id: \.self) { o in
                                Button(o) { submit(o) }.buttonStyle(SecondaryButtonStyle()).disabled(held != nil || sending)
                            }
                        }
                    }
                    HStack(spacing: Space.s) {
                        TextField("Answer", text: $answer).textFieldStyle(.roundedBorder).disabled(held != nil || sending)
                            .onSubmit { submit(answer) }
                        Button("Answer") { submit(answer) }.buttonStyle(PondPrimaryButtonStyle())
                            .disabled(held != nil || sending || answer.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
            .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        }
        .onChange(of: answer) { _, new in new.isEmpty ? stopHolding() : startHolding() }
        .onDisappear { stopHolding() }
    }

    /// Typing an answer holds the question (30 s, renewed while there are words in the box).
    private func startHolding() {
        guard holdTask == nil else { return }
        holdTask = Task {
            while !Task.isCancelled {
                let r = await ponds.hold(pond: pondId, thread: threadId, requestId: requestId)
                if !r.ok { refusal = PondHolds.refused(by: r.heldBy); holdTask = nil; return }
                refusal = nil
                try? await Task.sleep(for: .seconds(PondHolds.renewEvery))
            }
        }
    }

    private func stopHolding() { holdTask?.cancel(); holdTask = nil }

    private func submit(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !sending else { return }
        sending = true
        Task {
            let result = await ponds.answer(pond: pondId, thread: threadId, requestId: requestId, answer: t)
            sending = false
            switch result {
            case .sent?: answer = ""; refusal = nil; stopHolding(); await ponds.refresh(pond: pondId)
            case .held(let by)?: refusal = PondHolds.refused(by: by)
            case nil: break
            }
        }
    }
}
