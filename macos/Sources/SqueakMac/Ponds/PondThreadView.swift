import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, a thread from a shared pond in the normal workbench: the same header and tab strip, transcript and
// composer a chat of one's own has, fed by the host's `ThreadEvent`s (resumed from the last seq, read again on the
// stream's `changed`). This is an adapter, not a guest view: what a person may do comes from one pure type
// (`ThreadAccess`, SqueakMacCore): a member messages, steers and answers; a viewer only watches; what the starter keeps
// (approve, stop) is drawn disabled with the reason as its tooltip, never as a banner (docs/ponds.md, "Permissions").

struct PondThreadView: View {
    /// The pond's directory key; `project` reads its name.
    let key: String
    private var project: String { ponds.name(key: key) }
    let pondId: String
    let threadId: String
    @Environment(AppModel.self) private var model
    @State private var events: [ThreadEvent] = []
    @State private var draft = ""
    @State private var sending = false
    @State private var focusToken = 0
    @State private var typingTask: Task<Void, Never>?
    /// The Changes pane (read-only, from the starter's answer to a signed `diff` command).
    @State private var showChanges = false
    @State private var changes: PondChanges?
    @State private var changesRequest: String?
    @State private var changesStamp: Int?
    @State private var pickedFile: String?
    @State private var patch: PondChanges.Patch?
    @State private var changesLine: String?

    private var ponds: PondsModel { .shared }
    private var detail: PondDetail? { ponds.details[pondId] }
    private var thread: PondThread? { detail?.threads.first { $0.id == threadId } }
    private var members: [FlockMember] { detail?.members ?? [] }
    private var me: String? { detail?.meMember?.id ?? detail?.me?.id }
    private var role: PondRole { detail?.myRole ?? .viewer }
    private var rows: [ThreadRow] { ThreadTimeline.rows(events) }
    private var state: PondThreadState { ThreadTimeline.latestState(events) ?? PondThreadState(raw: thread?.state ?? "") }
    private var working: Bool { state == .working }
    private var access: ThreadAccess { ThreadAccess(role: role, starter: thread?.starter ?? "", me: me, starterName: starterName, asks: thread?.asks) }
    private var starterMember: FlockMember? { members.first { $0.id == thread?.starter } }
    private var laid: [GroupChat.Entry] {
        GroupChat.lay(rows, starter: thread?.starter ?? "", me: me, nameOf: { name($0) }, pendingMine: !(ponds.outbox[threadId] ?? []).isEmpty)
    }
    private var isGroup: Bool { GroupChat.isGroup(rows, starter: thread?.starter ?? "", me: me, pendingMine: !(ponds.outbox[threadId] ?? []).isEmpty) }
    private var starterName: String {
        guard let t = thread else { return "" }
        return t.starterName.isEmpty ? name(t.starter) : t.starterName
    }
    private func name(_ id: String?) -> String { members.first { $0.id == id }?.name ?? "" }

    var body: some View {
        HStack(spacing: 0) {
            centre
            if showChanges {
                Rectangle().fill(Theme.line).frame(width: 1)
                changesPane.frame(width: 360).transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(Motion.quick, value: showChanges)
        .onChange(of: showChanges) { _, open in if open { askChanges() } }
        // The thread's turn ended (the starter wrote its changed-files event): an open pane asks again. Nothing polls.
        .onChange(of: PondChangesView.turnEndStamp(events)) { _, _ in if showChanges { askChanges() } }
        // The pond says something changed: an answer we are waiting for may be there.
        .onChange(of: ponds.changeTick[pondId] ?? 0) { _, _ in readChangesAnswer() }
    }

    private var centre: some View {
        VStack(spacing: 0) {
            header
            tabStrip
            PondFreshnessStrip(pond: detail?.pond).padding(.horizontal, Space.l)
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
        // A heartbeat every 20 s while the thread is on screen, so "viewing" and "online" are right for the others.
        .pondHeartbeat(pond: pondId, viewing: threadId, typing: { !draft.isEmpty })
        .onAppear { ponds.note = nil }
        .onDisappear { typingTask?.cancel(); ponds.presence(pond: pondId, viewing: "", typing: false) }
    }

    private func readEvents() async {
        // Pages until the host has nothing after what is held.
        for _ in 0..<20 {
            guard let page = await ponds.events(pond: pondId, thread: threadId, after: ThreadTimeline.resumeSeq(events)), !page.events.isEmpty else { return }
            events = ThreadTimeline.merge(events, page.events)
            ponds.outbox[threadId] = PondOutbox.settle(ponds.outbox[threadId] ?? [], events: events, me: me)
            if page.lastSeq <= ThreadTimeline.resumeSeq(events) { return }
        }
    }

    // MARK: Changes

    /// Asks the starter's Mac for what changed (and, with `path`, that file's patch).
    private func askChanges(path: String? = nil) {
        changesStamp = PondChangesView.turnEndStamp(events)
        if changes == nil { changes = PondChangesView.fromEvents(events) }
        changesLine = nil
        Task {
            guard let reply = await ponds.askChanges(pond: pondId, thread: threadId, path: path) else {
                changesLine = "Changes are not available right now."
                return
            }
            if reply.ready, let result = reply.result { apply(result); return }
            changesRequest = reply.requestId
            readChangesAnswer()
            // Still no answer after a moment: the starter's Mac is probably away.
            try? await Task.sleep(for: .seconds(15))
            if changesRequest == reply.requestId, let line = thread.flatMap(PondThreadStatus.line) { changesLine = line }
        }
    }

    private func readChangesAnswer() {
        guard let request = changesRequest else { return }
        Task {
            guard let result = await ponds.readChanges(pond: pondId, thread: threadId, request: request) else { return }
            if changesRequest == request { changesRequest = nil; changesLine = nil; apply(result) }
        }
    }

    private func apply(_ result: PondChanges) {
        // A file-list answer keeps the open file's patch; a patch answer fills it.
        changes = result
        if let p = result.patch { patch = p }
    }

    private func pick(_ path: String) {
        pickedFile = pickedFile == path ? nil : path
        patch = nil
        if pickedFile != nil { askChanges(path: path) }
    }

    /// The normal Changes view, read-only: the starter's file list with the same rows, a file's diff under it.
    private var changesPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Changes").font(Typo.label).foregroundStyle(Theme.ink)
                Spacer(minLength: 0)
                if let s = changes?.summary {
                    HStack(spacing: 6) {
                        Text("+\(s.added)").foregroundStyle(Theme.success)
                        Text("\u{2212}\(s.removed)").foregroundStyle(Theme.negative)
                    }
                    .font(.system(size: 12, design: .monospaced)).monospacedDigit()
                }
            }
            .padding(.horizontal, Space.m).frame(height: Metrics.header)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let c = changes {
                        if c.files.isEmpty {
                            Text("No changes yet.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                        } else {
                            Text(PondChangesView.header(c)).font(.system(size: 16)).foregroundStyle(Theme.ink)
                                .padding(.horizontal, Space.m).padding(.vertical, 10)
                            ForEach(PondChangesView.listing(c)) { file in
                                ChangeRow(file: file, open: pickedFile == file.path, showsFolder: true) { pick(file.path) }
                                if pickedFile == file.path { pondDiff(file.path) }
                            }
                        }
                    } else {
                        Text(changesRequest != nil ? "Asking \(starterName.isEmpty ? "the starter" : starterName)\u{2019}s Mac\u{2026}" : "No changes to show.")
                            .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                    }
                    if let line = changesLine { Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.warning).padding(.horizontal, Space.m).padding(.top, Space.s) }
                }
                .padding(.bottom, Space.m)
            }
        }
        .background(Theme.surface.opacity(0.4))
    }

    @ViewBuilder private func pondDiff(_ path: String) -> some View {
        if let patch, patch.path == path {
            let lines = DiffParser.lines(patch.text)
            Group {
                if lines.isEmpty { DiffNote(text: "No textual diff to show.") }
                else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(0..<lines.count, id: \.self) { i in DiffLineView(line: lines[i], selected: false, commented: false, onGutter: { _ in }, readOnly: true) }
                        }
                        .fixedSize(horizontal: true, vertical: false).frame(minWidth: 280, alignment: .leading)
                    }
                    if patch.truncated { DiffNote(text: "Diff cut at 1 MB.").padding(.top, 4) }
                }
            }
            .padding(.vertical, 6).background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .padding(.horizontal, Space.s).padding(.bottom, 4)
        } else {
            DiffNote(text: changesRequest != nil ? "Reading the diff\u{2026}" : "Could not read this file\u{2019}s diff.").padding(.horizontal, Space.m).padding(.bottom, 6)
        }
    }

    // MARK: Header

    /// The workbench's 44pt header: the pond, then the thread, with the same controls a chat of one's own has. What the
    /// starter keeps (Stop) is here too, disabled, with the reason.
    private var header: some View {
        HStack(spacing: Space.s) {
            CrumbLink(title: project, label: "Open \(project)\u{2019}s dashboard") { ponds.route = .home(project: key) }
            Lucide(.chevronRight, size: 12, color: Theme.subtle)
            Text(verbatim: thread?.title.isEmpty == false ? thread!.title : "Thread").lineLimit(1).foregroundStyle(Theme.ink)
            PondStateMark(state: state)
            if let ownership = ThreadOwnership.line(starterName: starterName, isMine: access.isMine),
               let avatar = ThreadOwnership.tabAvatar(starterId: thread?.starter ?? "", starterName: starterName, isMine: false) {
                PondAvatarDot(spec: avatar, size: CGFloat(GroupChat.avatarSize)).padding(.leading, Space.s)
                Text(verbatim: ownership).font(Typo.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: Space.m)
            let viewers = PondFlock.viewers(of: threadId, members: members, presence: detail?.presence ?? [], excluding: me)
            ForEach(viewers) { v in FlockAvatar(member: v, online: true, size: 22).help("\(v.name) is here") }
            let view = access.gate(.viewChanges)
            if view.visible {
                Button { showChanges.toggle() } label: {
                    Lucide(.layers, size: 14, color: showChanges ? Theme.ink : Theme.subtle).frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!view.enabled).help(showChanges ? "Hide changes" : "Show changes")
                .accessibilityLabel(showChanges ? "Hide changes" : "Show changes")
            }
            if !access.isMine {
                let stop = access.gate(.stop)
                Button { } label: { Lucide(.square, size: 14, color: Theme.subtle).frame(width: 28, height: 28).contentShape(Rectangle()) }
                    .buttonStyle(.plain).disabled(!stop.enabled).help(stop.tooltip ?? "Stop")
                    .accessibilityLabel("Stop").accessibilityHint(stop.tooltip ?? "")
            }
            let priv = access.gate(.togglePrivate)
            if priv.visible {
                Toggle("Private", isOn: Binding(get: { thread?.isPrivate ?? false }, set: { v in Task { await ponds.setPrivate(pond: pondId, thread: threadId, isPrivate: v) } }))
                    .toggleStyle(.switch).controlSize(.small).font(Typo.body).help("Only you see a private thread")
            }
        }
        .font(.system(size: 15, weight: .medium))
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }

    /// The tab strip: this thread's tab, marked as the starter's when it is not mine (their avatar; the tooltip says whose
    /// thread it is and where it runs).
    private var tabStrip: some View {
        HStack(spacing: Space.s) {
            HStack(spacing: 7) {
                if let avatar = ThreadOwnership.tabAvatar(starterId: thread?.starter ?? "", starterName: starterName, isMine: access.isMine) {
                    PondAvatarDot(spec: avatar, size: 16)
                } else {
                    ThreadDuckView(id: threadId, agent: thread?.agent, size: ThreadDuck.Size.tab)
                }
                Text(verbatim: thread?.title.isEmpty == false ? thread!.title : "Thread").font(.system(size: 14)).foregroundStyle(Theme.ink)
                    .lineLimit(1).frame(maxWidth: ChatTabWidth.maxTitle, alignment: .leading)
            }
            .padding(.leading, ChatTabWidth.leadingPad).padding(.trailing, ChatTabWidth.trailingPad)
            .frame(minHeight: Metrics.tabStrip, maxHeight: Metrics.tabStrip)
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.ink).frame(height: 2) }
            .help(ThreadOwnership.tabHelp(title: thread?.title ?? "", starterName: starterName, isMine: access.isMine))
            .accessibilityElement(children: .combine).accessibilityAddTraits(.isSelected)
            Spacer(minLength: Space.m)
            if let line = thread.flatMap(PondThreadStatus.line), thread?.starterOnline == false {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.warning).lineLimit(1)
            }
        }
        .padding(.horizontal, Space.l)
        .frame(height: Metrics.tabStrip)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(laid) { entry in entryView(entry).id(entry.id) }
                    if rows.isEmpty, ponds.outbox[threadId]?.isEmpty ?? true { Text("Nothing in this thread yet.").font(Typo.body).foregroundStyle(Theme.subtle) }
                    ForEach(ponds.outbox[threadId] ?? []) { o in outgoing(o) }
                }
                .padding(.horizontal, Space.l).padding(.vertical, Space.m)
                .frame(maxWidth: Metrics.workbenchColumn, alignment: .leading).frame(maxWidth: .infinity)
            }
            .onChange(of: rows.last?.id) { _, id in if let id { withAnimation(Motion.quick) { proxy.scrollTo(id, anchor: .bottom) } } }
        }
    }

    /// A group chat (more than one person has spoken) draws each human message with a 22pt avatar; a thread with one
    /// person talking draws exactly what it always did. The agent's replies stay full width either way.
    @ViewBuilder private func entryView(_ entry: GroupChat.Entry) -> some View {
        switch entry {
        case .plain(let row): rowView(row)
        case .message(let id, let m): groupMessage(id: id, m)
        }
    }

    private func groupMessage(id: Int, _ m: GroupChat.Message) -> some View {
        let agent = SessionText.agentName(thread?.agent) ?? "Agent"
        let bubble = VStack(alignment: m.side == .trailing ? .trailing : .leading, spacing: 3) {
            if m.showsName { Text(verbatim: GroupChat.label(for: m, name: name(m.author))).font(Typo.meta).foregroundStyle(Theme.muted) }
            MessageView(message: ChatMessage(id: "pond-\(id)", role: .user, text: m.text, at: m.at), agentName: agent, canOpenHost: false, agentWorking: false)
        }
        return HStack(alignment: .top, spacing: Space.s) {
            if m.side == .trailing { Spacer(minLength: 0) }
            if m.side == .leading { avatarSlot(m) }
            bubble
            if m.side == .trailing { avatarSlot(m) }
            if m.side == .leading { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: m.side == .trailing ? .trailing : .leading)
    }

    /// The avatar sits beside the first message of a run; the rest of the run keeps the same gutter.
    @ViewBuilder private func avatarSlot(_ m: GroupChat.Message) -> some View {
        if m.showsName { PondAvatarDot(spec: m.avatar, size: CGFloat(GroupChat.avatarSize)).help(name(m.author)) }
        else { Color.clear.frame(width: CGFloat(GroupChat.avatarSize), height: CGFloat(GroupChat.avatarSize)) }
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
            PondQuestionCard(pondId: pondId, threadId: threadId, requestId: requestId, text: text, options: options, resolved: resolved, me: me, canAnswer: access.canAnswer, denied: access.gate(.answer).tooltip)
        case .approval(_, _, let label, let resolved):
            approval(label: label, resolved: resolved)
        case .changed(_, let files, let added, let removed):
            if let line = PondSentence.changed(files: files, added: added, removed: removed) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
        }
    }

    /// A message this person sent that the starter's Mac has not shown yet, with where it has got to.
    private func outgoing(_ o: PondOutgoing) -> some View {
        TimelineView(.periodic(from: .now, by: 15)) { ctx in
            HStack(alignment: .top, spacing: Space.s) {
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 3) {
                MessageView(message: ChatMessage(id: "out-\(o.id)", role: .user, text: o.text, at: o.sentAt), agentName: "Agent", canOpenHost: false, agentWorking: false)
                    .opacity(o.isRefused ? 0.6 : 0.85)
                HStack(spacing: Space.s) {
                    Text(verbatim: o.line(starter: starterName, now: ctx.date)).font(Typo.footnote)
                        .foregroundStyle(o.isRefused ? Theme.negative : Theme.muted).fixedSize(horizontal: false, vertical: true)
                    if o.isRefused {
                        Button("Put it back") { draft = o.text; ponds.dismissOutgoing(thread: threadId, id: o.id); focusToken += 1 }.buttonStyle(.plain).font(Typo.footnote).foregroundStyle(Theme.ink)
                        Button("Dismiss") { ponds.dismissOutgoing(thread: threadId, id: o.id) }.buttonStyle(.plain).font(Typo.footnote).foregroundStyle(Theme.muted)
                    }
                }
            }
            if isGroup, let me { PondAvatarDot(spec: PondAvatars.spec(memberId: me, name: name(me)), size: CGFloat(GroupChat.avatarSize)) }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }

    /// Shown so people know why the thread waits. Approving stays with the starter on their own Mac: the control is here,
    /// disabled, and its tooltip says who can.
    private func approval(label: String, resolved: Bool) -> some View {
        let gate = access.gate(.approve)
        return HStack(alignment: .top, spacing: Space.s) {
            Lucide(.triangleAlert, size: 14, color: resolved ? Theme.subtle : Theme.warning)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: label).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                if resolved { Text("Resolved").font(Typo.footnote).foregroundStyle(Theme.muted) }
            }
            Spacer(minLength: 0)
            if !resolved {
                Button("Approve") { }.buttonStyle(SecondaryButtonStyle()).disabled(!gate.enabled).help(gate.tooltip ?? "Approve on your own Mac")
            }
        }
        .padding(Space.m).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }

    // MARK: Composer

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let line = PondFlock.typingLine(in: threadId, members: members, presence: detail?.presence ?? [], excluding: me) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted)
            }
            if let note = ponds.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative).textSelection(.enabled) }
            if case .watchOnly(let line) = access.composer(working: working) {
                Text(verbatim: line).font(Typo.footnote).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
            } else if case .closed(let block) = access.composer(working: working) {
                Text(verbatim: block).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.vertical, 12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            } else {
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
            // The message moves under the transcript at once, with its state; a refusal says why right there.
            draft = ""
            _ = await ponds.send(pond: pondId, thread: threadId, text: text, mode: mode)
            await readEvents()
            sending = false
            focusToken += 1
        }
    }

    /// Typing is told to the flock while words are in the box, renewed before the host lets it lapse.
    private func typing(_ on: Bool) {
        typingTask?.cancel()
        ponds.presence(pond: pondId, viewing: threadId, typing: on)
        guard on else { return }
        // The heartbeat renews it every 20 s while words are in the box.
        typingTask = nil
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
    /// A viewer reads only: no buttons, no answer box.
    var canAnswer = true
    /// Why answering is off (a viewer: "You can watch this pond"), drawn as one muted line.
    var denied: String?
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
                } else if !canAnswer {
                    Text(verbatim: denied ?? ThreadAccess.watchLine).font(Typo.footnote).foregroundStyle(Theme.muted)
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


/// A person's avatar with no photo: initials on a soft colour derived from their member id (`PondAvatars`), light and dark.
struct PondAvatarDot: View {
    let spec: AvatarSpec
    var size: CGFloat = CGFloat(GroupChat.avatarSize)

    var body: some View {
        Text(verbatim: spec.initials).font(.system(size: size * 0.42, weight: .semibold)).foregroundStyle(Theme.ink)
            .frame(width: size, height: size).background(PondColour.swatch(hue: spec.hue), in: Circle())
            .accessibilityHidden(true)
    }
}

/// A breadcrumb part: a plain button with the pointing hand.
struct CrumbLink: View {
    let title: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) { Text(verbatim: title).lineLimit(1).foregroundStyle(Theme.muted).contentShape(Rectangle()) }
            .buttonStyle(.plain).accessibilityLabel(label).help(label)
    }
}
