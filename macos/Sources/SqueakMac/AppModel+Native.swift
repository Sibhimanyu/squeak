import AppKit
import Foundation
import Observation
import SqueakMacCore

/// The agent's message as it is being written, in an observable of its own that only the streaming leaf view reads, so
/// a token never invalidates the detail view around it. Text reaches it at most ~15 times a second (`PublishGate`); a
/// push that is held back is published by a trailing flush, so the last words always arrive.
@MainActor @Observable
final class StreamingTextBuffer {
    private(set) var text = ""
    @ObservationIgnored private var latest = ""
    @ObservationIgnored private var gate = PublishGate()
    @ObservationIgnored private var trailing: Task<Void, Never>?

    func push(_ full: String, force: Bool = false) {
        latest = full
        let now = Date()
        if gate.admit(now: now, force: force || full.isEmpty) {
            trailing?.cancel(); trailing = nil
            if text != full { text = full }
        } else if trailing == nil {
            let delay = gate.wait(now: now)
            trailing = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled, let self else { return }
                trailing = nil
                _ = gate.admit(now: Date(), force: true)
                if text != latest { text = latest }
            }
        }
    }

    func clear() { trailing?.cancel(); trailing = nil; latest = ""; if !text.isEmpty { text = "" } }
}

/// What the open Squeak-run chat shows beyond its transcript: the host's record of it, the card that waits on
/// the person, the text being written, the queue. One chat at a time (the one on screen).
@MainActor @Observable
final class NativeChatModel {
    var key: SessionKey?
    var info: NativeSession?
    var card: NativeCard?
    @ObservationIgnored let stream = StreamingTextBuffer()
    /// Runs the action that failed again; set only for a failure on the host's side.
    var retry: (() -> Void)?
    /// The queue stack above the composer: the host's queued messages and steers in flight, and this Mac's own sends
    /// that it has not listed yet (NativePending.swift). Replaces the plain queue read.
    var pending = NativePendingStack()
    /// The host announces `pending` events itself (a newer host): then a bare `queue` frame needs no read.
    @ObservationIgnored var hostSendsPending = false
    /// A queued message being edited (held on the host), so it is released if the chat is left.
    var editingPendingId: String?
    /// A quiet line under the composer: a refusal in the host's own words, never a raw error.
    var note: String?
    var queueNote: String?
    var busy = false
    var flow: NativeQuestionFlow?
    /// The chat's allow rules ("Allow for this session"); nil when the host has no rules route, so the inspector hides the section.
    /// The host's projects, for the sidebar's "+" (a project row gets it only when the host runs chats there).
    var projects: [NativeProject] = []
    /// The project a workspace is being made in (its "+" shows a spinner).
    var makingWorkspaceIn: String?
    var rules: [NativeRule]?
    var rulesNote: String?
    /// The host rejected `allowEditsForChat`: the button stays hidden (kept across chats, cleared when the app restarts).
    var editsForChatUnsupported = false
    /// The chats warmed since this window opened them, once each per opening (`WarmGate`).
    @ObservationIgnored var warmGate = WarmGate()
    /// A deny's reason is typed into the composer; this is the last mode the person picked, shown at once.
    var modeOverride: ComposerMode?
    /// Bumped when a preset is recorded for the chat, so the model menu re-reads which preset it is on.
    var presetTick = 0
    /// Newest message seq the stream delivered for the open chat.
    @ObservationIgnored var lastSeq = 0
    @ObservationIgnored var refreshTask: Task<Void, Never>?
    @ObservationIgnored var refreshAgain = false
    /// Silence after a send, and the safety poll (SqueakMacCore `NativeSyncWatchdog`).
    @ObservationIgnored var watchdog = NativeSyncWatchdog()
    /// Set by the watchdog: drop the stream and open it again from the newest seq.
    @ObservationIgnored var forceReconnect = false
    @ObservationIgnored var cutStream: (() -> Void)?

    var mode: ComposerMode? {
        modeOverride ?? info.map { NativeModes.composerMode($0.permissionMode) }
    }

    func reset(_ key: SessionKey?) {
        self.key = key; info = nil; card = nil; stream.clear(); retry = nil; pending.reset(); hostSendsPending = false; editingPendingId = nil; note = nil; queueNote = nil
        busy = false; flow = nil; modeOverride = nil; rules = nil; rulesNote = nil
    }

    func show(requests: [NativeRequest], agent: String) {
        let next = NativeCards.card(for: requests, agent: agent)
        guard next?.id != card?.id else { return }
        card = next
        flow = next.flatMap { $0.kind == .question ? NativeQuestionFlow(texts: $0.questionTexts) : nil }
    }
}

extension AppModel {
    /// The controls of a chat Squeak runs itself; nil for every other source (and in demo runs, which touch no host).
    func nativeControls(for s: HostSession) -> (any NativeChatControls)? {
        s.source == .squeak ? nativeAdapter : nil
    }

    private func agentName(_ s: HostSession) -> String { s.agent == "codex" ? "Codex" : "Claude" }

    // MARK: Live

    /// Runs while a native chat is on screen (the view's `.task`): reads what the host knows, then follows the
    /// stream. It ends with the task, so a chat that is not visible holds no connection.
    func runNativeChat(_ s: HostSession) async {
        let key = s.key
        native.reset(key)
        if demoMode {
            native.info = DemoData.nativeInfo(for: s)
            native.card = DemoData.nativeCard(for: s)
            if native.card?.kind == .question { native.flow = NativeQuestionFlow(texts: native.card?.questionTexts ?? []) }
            if chatModels.isEmpty { chatModels = DemoData.chatModels }
            return
        }
        // Opening the chat warms its agent, once per opening; an older host's 404 is ignored.
        if native.warmGate.shouldWarm(key) { Task { await nativeAdapter.warm(s) } }
        // A keep-alive every 30 minutes while the chat stays on screen (this task ends with it).
        let keepAlive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(WarmGate.reopenAfter - 60))
                guard !Task.isCancelled, let self else { return }
                if native.warmGate.shouldWarm(key, now: Date().addingTimeInterval(60)) { await nativeAdapter.warm(s) }
            }
        }
        defer { keepAlive.cancel() }
        await refreshNative(s)
        if chatModels.isEmpty { chatModels = await client.chatModels() }
        let prefix = NativeAdapter.keyPrefix
        let hostId = key.hostSessionId.hasPrefix(prefix) ? String(key.hostSessionId.dropFirst(prefix.count)) : key.hostSessionId
        let newest = (try? await nativeHost.messages(id: hostId, before: nil, limit: 1))?.last?.seq ?? 0
        var live = NativeLiveState()
        native.watchdog = NativeSyncWatchdog()
        native.lastSeq = newest
        native.forceReconnect = false
        // The stream reconnects by itself on EOF, error or silence; this loop also reopens it when the watchdog says
        // a send went unanswered, and polls the host's status/seq as a safety net while the chat is working.
        let ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled, let self, native.key == key else { return }
                switch native.watchdog.tick(at: Date()) {
                case .none: break
                case .reconnect:
                    native.forceReconnect = true
                    native.cutStream?()
                case .poll:
                    let hostId = key.hostSessionId.hasPrefix(prefix) ? String(key.hostSessionId.dropFirst(prefix.count)) : key.hostSessionId
                    guard let session = try? await nativeHost.session(id: hostId) else { continue }
                    let newestSeq = (try? await nativeHost.messages(id: hostId, before: nil, limit: 1))?.last?.seq ?? 0
                    if NativeSyncWatchdog.mismatch(hostStatus: session.status, hostLastSeq: newestSeq, status: native.watchdog.status, lastSeq: native.lastSeq) {
                        native.forceReconnect = true
                        native.cutStream?()
                    }
                }
            }
        }
        defer { ticker.cancel(); native.cutStream?(); native.cutStream = nil }
        var resumeAfter = newest
        outer: while !Task.isCancelled && native.key == key {
        native.forceReconnect = false
        native.watchdog.noteReconnect(at: Date())
        if resumeAfter != newest { await refetchNative(s) }
        let source = nativeAdapter.events(for: s, after: resumeAfter)
        let events = AsyncStream<NativeEvent> { c in
            let pump = Task { for await e in source { c.yield(e) }; c.finish() }
            native.cutStream = { pump.cancel(); c.finish() }
            c.onTermination = { _ in pump.cancel() }
        }
        for await event in events {
            if Task.isCancelled || native.key != key { break outer }
            native.watchdog.noteEvent(at: Date())
            if case .status(let st) = event { native.watchdog.noteStatus(st) }
            if case .message(let m) = event {
                native.lastSeq = max(native.lastSeq, m.seq)
                noteOptimistic(key) { $0.observe(message: m.seq, role: m.role == "user" ? .user : .assistant) }
            }
            if case .status(let st) = event {
                noteOptimistic(key) { $0.observe(status: Self.sessionState(hostStatus: st)) }
                applyHostStatus(key, Self.sessionState(hostStatus: st))
            }
            if let change = event.pendingChange {
                native.hostSendsPending = true
                native.pending.apply(change)
                // A steer taken in is a plain transcript row now: read it so it shows at once.
                if case .remove(_, true, _) = change { scheduleNativeRefresh() }
            }
            let effect = live.apply(event)
            if case .delta = event { native.stream.push(live.streamingText) } else { native.stream.push(live.streamingText, force: true) }
            switch event {
            case .request, .requestResolved, .connected, .reset:
                // After a reset or a reconnect the held requests are cleared and the host re-sends the live ones.
                native.show(requests: live.requests, agent: agentName(s))
            case .status:
                if let info = try? await nativeAdapter.info(for: s), native.key == key { native.info = info }
                // Every status moves the catalog's row (the working row follows it), so read it now.
                await broker.nudge()
                if native.key == key, let status = live.status {
                    if NativeLiveState.needsRequestRefetch(status: status, hasCard: native.card != nil) {
                        // Waiting on the person with no card: the request event was missed. Ask the host for its list.
                        if let list = try? await nativeAdapter.openRequests(for: s), native.key == key {
                            live.replaceRequests(list)
                            native.show(requests: list, agent: agentName(s))
                        }
                    } else if !NativeLiveState.needsRequestRefetch(status: status, hasCard: false) {
                        native.card = nil
                    }
                }
            case .queueChanged:
                _ = live.takeQueueDirty()
                if !native.hostSendsPending { await refreshNativePending(s) }
            default: break
            }
            switch effect {
            case .transcriptChanged, .refetch: scheduleNativeRefresh()
            case .none: break
            }
        }
        if Task.isCancelled || native.key != key { break }
        // The stream ended (a forced reconnect, or the consumer was cut): reopen from what the Mac has.
        resumeAfter = max(native.lastSeq, newest)
        }
    }

    /// After a forced reconnect: read the chat's status, requests and queue and the transcript again.
    func refetchNative(_ s: HostSession) async {
        await refreshNative(s)
        scheduleNativeRefresh()
    }

    /// Committed messages arrive through the transcript read (merged with this Mac's own sends), so a burst of
    /// stream events costs one read.
    private func scheduleNativeRefresh() {
        guard native.refreshTask == nil else { native.refreshAgain = true; return }
        native.refreshTask = Task { [weak self] in
            guard let self else { return }
            repeat {
                native.refreshAgain = false
                try? await Task.sleep(for: .milliseconds(120))
                await broker.refreshTranscript()
                await refreshActivity()
            } while native.refreshAgain && !Task.isCancelled
            native.refreshTask = nil
        }
    }

    func refreshNative(_ s: HostSession) async {
        guard let c = nativeControls(for: s) else { return }
        if let info = try? await c.info(for: s), native.key == s.key { native.info = info }
        if let requests = try? await c.openRequests(for: s), native.key == s.key { native.show(requests: requests, agent: agentName(s)) }
        await refreshNativePending(s)
        await refreshNativeRules(s)
    }

    func refreshNativeRules(_ s: HostSession) async {
        guard let c = nativeControls(for: s) else { return }
        // nil (404, an older host) hides the section; a failed read keeps what was last shown.
        do {
            let rules = try await c.rules(for: s)
            if native.key == s.key, rules != native.rules { native.rules = rules }
        } catch {}
    }

    func nativeRemoveRule(_ s: HostSession, _ rule: NativeRule) {
        if demoMode { native.rulesNote = "Demo data: nothing is removed."; return }
        guard let c = nativeControls(for: s) else { return }
        native.rulesNote = nil
        Task { [weak self] in
            guard let self else { return }
            let r = await c.removeRule(s, ruleId: rule.id)
            switch r {
            case .done: break
            case .refused(let why), .failed(let why): native.rulesNote = why
            }
            await refreshNativeRules(s)
        }
    }

    func refreshNativePending(_ s: HostSession) async {
        guard let c = nativeControls(for: s), let list = try? await c.pending(for: s), native.key == s.key else { return }
        native.pending.apply(.snapshot(list))
        native.pending.prune(now: Date())
    }

    /// The host's status word as the state the chat shows.
    static func sessionState(hostStatus: String) -> SessionState {
        switch hostStatus {
        case "working", "cancelling", "waiting": .working
        case "idle": .idle
        case "error": .error
        case "needs_user_permission", "needs_plan_response", "needs_user_input": .blocked
        default: .unknown
        }
    }

    // MARK: Cards

    func nativeCardAction(_ s: HostSession, _ work: @escaping (any NativeChatControls, NativeCard) async -> NativeActionResult) {
        guard !native.busy, let card = native.card else { return }
        if demoMode { native.note = "Demo data: nothing is sent."; return }
        guard let c = nativeControls(for: s) else { return }
        native.busy = true
        native.note = nil
        native.retry = nil
        Task { [weak self] in
            guard let self else { return }
            let result = await work(c, card)
            native.busy = false
            switch result {
            case .done:
                // The stream's request-resolved clears the card; clear it now too so a double press can't answer twice.
                if native.card?.id == card.id { native.card = nil }
            case .refused(let reason):
                native.note = reason
                await refreshNative(s)
            case .failed(let reason):
                native.note = reason
                native.retry = { [weak self] in self?.native.retry = nil; self?.nativeCardAction(s, work) }
                await refreshNative(s)
            }
        }
    }

    func nativeAllow(_ s: HostSession) {
        nativeCardAction(s) { c, card in await c.respond(requestId: card.id, allow: true, message: nil, answers: nil) }
    }

    /// Allow this request and keep an allow rule for the chat. An older host says to update the service.
    func nativeAllowForSession(_ s: HostSession) {
        nativeCardAction(s) { c, card in
            let r = await c.allowForSession(requestId: card.id)
            if r == .done { await self.refreshNativeRules(s) }
            return r
        }
    }

    /// Allow this edit and every edit for the rest of the chat. A host without it hides the button and the request is
    /// allowed once, so the person is never left stuck on the card.
    func nativeAllowEditsForChat(_ s: HostSession) {
        nativeCardAction(s) { c, card in
            let r = await c.allowEditsForChat(requestId: card.id)
            if case .refused = r {
                await MainActor.run { self.native.editsForChatUnsupported = true }
                return await c.respond(requestId: card.id, allow: true, message: nil, answers: nil)
            }
            if r == .done { await self.refreshNativeRules(s) }
            return r
        }
    }

    /// Deny, with what the person typed ("tell it what to do instead") when there is something.
    func nativeDeny(_ s: HostSession, message: String? = nil) {
        let text = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        nativeCardAction(s) { c, card in await c.respond(requestId: card.id, allow: false, message: text?.isEmpty == false ? text : nil, answers: nil) }
        if text?.isEmpty == false { setDraft("") }
    }

    /// Approve = allow, then leave plan mode for Accept edits unless the chat was already moved elsewhere.
    func nativeApprovePlan(_ s: HostSession) {
        let current = native.info?.permissionMode ?? "plan"
        nativeCardAction(s) { c, card in
            let result = await c.respond(requestId: card.id, allow: true, message: nil, answers: nil)
            if result == .done, let next = NativeModes.modeAfterPlanApproval(current: current) {
                _ = await c.setMode(s, to: next)
                await MainActor.run { self.native.modeOverride = NativeModes.composerMode(next) }
            }
            return result
        }
    }

    /// Keep planning = deny, with the person's words when they typed some.
    func nativeKeepPlanning(_ s: HostSession, message: String? = nil) {
        let text = message?.trimmingCharacters(in: .whitespacesAndNewlines)
        let reply = text?.isEmpty == false ? text! : NativeCards.keepPlanningMessage
        nativeCardAction(s) { c, card in await c.respond(requestId: card.id, allow: false, message: reply, answers: nil) }
        if text?.isEmpty == false { setDraft("") }
    }

    /// An option (or, with `other`, the person's own words) answers the current question; the last answer sends.
    func nativeAnswer(_ s: HostSession, option index: Int?, other: String? = nil) {
        guard var flow = native.flow, let card = native.card, !flow.isComplete else { return }
        let q = card.questionModels.indices.contains(flow.index) ? card.questionModels[flow.index] : card.question ?? QuestionCardModel(question: "", options: [])
        let value: String
        if let other, !other.isEmpty { value = other }
        else if let index, q.options.indices.contains(index) { value = q.options[index].title }
        else { return }
        if !flow.answer(value) { native.flow = flow; return }
        native.flow = flow
        let answers = flow.json
        nativeCardAction(s) { c, card in await c.respond(requestId: card.id, allow: true, message: nil, answers: answers) }
    }

    // MARK: Controls

    func nativeSetMode(_ s: HostSession, _ mode: ComposerMode) {
        if demoMode { native.modeOverride = mode; return }
        guard let c = nativeControls(for: s) else { return }
        native.modeOverride = mode
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            let r = await c.setMode(s, to: NativeModes.permissionMode(mode))
            switch r {
            case .done: await refreshNative(s); native.modeOverride = nil
            case .refused(let why), .failed(let why): native.note = why; native.modeOverride = nil
            }
        }
    }

    /// `preset` (picked from the menu's Presets section): its split goes with the chat's next message, and is remembered
    /// so the menu can say which preset the chat is on, or Custom once it is edited away.
    func nativeSetModel(_ s: HostSession, modelId: String, effort: String?, preset: (ChatPreset, ChatSetup)? = nil) {
        if demoMode { native.note = "Demo data: nothing is changed."; return }
        guard let c = nativeControls(for: s) else { return }
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            let r = await c.setModel(s, model: modelId, effort: effort, split: preset.map { $0.1.split })
            if case .refused(let why) = r { native.note = why }
            if case .failed(let why) = r { native.note = why }
            if case .done = r, let preset { ChatSplitStore().applied(preset.0, setup: preset.1, chat: s.key.stringValue); native.presetTick += 1 }
            await refreshNative(s)
        }
    }

    func nativeInterrupt(_ s: HostSession) async {
        if demoMode { native.note = "Demo data: nothing is stopped."; return }
        guard let c = nativeControls(for: s) else { return }
        let r = await c.interrupt(s)
        if case .refused(let why) = r { native.note = why }
        if case .failed(let why) = r { native.note = why }
    }

    // MARK: Queue

    func nativeDeleteQueued(_ s: HostSession, _ id: String) async -> Bool {
        guard let c = nativeControls(for: s) else { return false }
        native.queueNote = nil
        let r = await c.removeQueued(s, queueId: id)
        await refreshNativePending(s)
        if case .done = r { return true }
        if case .refused(let why) = r { native.queueNote = why }
        if case .failed(let why) = r { native.queueNote = why }
        return false
    }

    /// Edit starts: the host holds the message, so nothing sends it while its words change.
    func nativeHoldQueued(_ s: HostSession, _ id: String) async -> Bool {
        guard let c = nativeControls(for: s) else { return false }
        native.queueNote = nil
        let r = await c.holdQueued(s, queueId: id, held: true, text: nil)
        if case .done = r { native.editingPendingId = id; await refreshNativePending(s); return true }
        if case .refused(let why) = r { native.queueNote = why }
        if case .failed(let why) = r { native.queueNote = why }
        return false
    }

    /// Edit ends: Save keeps the new words (and releases the hold); Cancel releases it with the old ones.
    func nativeReleaseQueued(_ s: HostSession, _ id: String, text: String?) async -> Bool {
        guard let c = nativeControls(for: s) else { return false }
        let r = await c.holdQueued(s, queueId: id, held: false, text: text)
        if native.editingPendingId == id { native.editingPendingId = nil }
        await refreshNativePending(s)
        if case .done = r { return true }
        if case .refused(let why) = r { native.queueNote = why }
        if case .failed(let why) = r { native.queueNote = why }
        return false
    }

    func nativeSteerQueued(_ s: HostSession, _ id: String) async {
        guard let c = nativeControls(for: s) else { return }
        native.queueNote = nil
        let r = await c.steerQueued(s, queueId: id)
        if case .refused(let why) = r { native.queueNote = NativeQueueNote.steerRefused(why, agent: agentName(s)) }
        if case .failed(let why) = r { native.queueNote = why }
        await refreshNativePending(s)
    }

    // MARK: New chat

    func nativeProjects() async -> [NativeProject]? {
        if demoMode { return DemoData.nativeProjects }
        return try? await nativeHost.projects()
    }

    func refreshNativeProjects() async {
        guard !demoMode else { native.projects = DemoData.nativeProjects; return }
        if let list = await nativeProjects(), list != native.projects { native.projects = list }
    }

    /// Makes a bird-named worktree in a project through the host, then opens New thread on it. A
    /// failure opens New thread on the pond with the reason in a plain sentence, so nothing is lost.
    func nativeMakeWorkspace(projectId: String, from source: NativeWorkspaceSource? = nil, prompt: String? = nil) {
        // The "+" next to a pond: the New branch page makes it.
        if source == nil, prompt == nil { openNewBranch(projectId: projectId); return }
        guard native.makingWorkspaceIn == nil else { return }
        if demoMode { NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: projectId, error: "Demo data: no stream is made.")); return }
        native.makingWorkspaceIn = projectId
        Task { [weak self] in
            guard let self else { return }
            var preset = NativeSheetPreset(projectId: projectId, text: prompt)
            do {
                if let source {
                    let made = try await nativeHost.createWorkspace(projectId: projectId, from: source)
                    preset.workspaceId = made.workspace.id
                    preset.text = made.prompt
                } else {
                    preset.workspaceId = try await nativeHost.createWorkspace(projectId: projectId).id
                }
                AppLog.info("native workspace made")
            } catch {
                preset.error = NativeWorkspaceMaking.problem(error)
            }
            native.makingWorkspaceIn = nil
            NewChatController.shared.show(nativePreset: preset)
        }
    }

    func nativeWorkspaces(projectId: String) async -> [NativeWorkspace] {
        if demoMode { return [] }
        return (try? await nativeHost.workspaces(projectId: projectId)) ?? []
    }

    func nativeCloneProject(url: String, name: String? = nil) async -> (NativeProject?, String?) {
        if demoMode { return (nil, "Demo data: nothing is cloned.") }
        do { return (try await nativeHost.cloneProject(url: url, name: name), nil) }
        catch let e as NativeHostError { return (nil, e.reason) }
        catch { return (nil, "Squeak couldn't clone that repository") }
    }

    func nativeAddProject(path: String, name: String? = nil) async -> (NativeProject?, String?) {
        if demoMode { return (nil, "Demo data: no folder is added.") }
        do { return (try await nativeHost.addProject(rootPath: path, name: name), nil) }
        catch let e as NativeHostError { return (nil, e.reason) }
        catch { return (nil, "Squeak couldn't add that folder") }
    }

    /// A deliberate press of Start chat. Never retried: the first message is what creates the chat.
    /// Selects a chat the host started on the person's behalf (a review on its own model) once the catalog lists it.
    func openStartedChat(hostSessionId id: String) async {
        let hostId = NativeAdapter.keyPrefix + id
        await broker.refresh()
        let end = Date().addingTimeInterval(5)
        while Date() < end {
            if let s = sessions.first(where: { $0.key.hostSessionId == hostId }) { open(s.key); return }
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    func startNativeChat(_ spec: NativeNewSession) async -> (SessionKey?, String?) {
        if demoMode { return (nil, "Demo data: nothing is started.") }
        do {
            let s = try await nativeHost.createSession(spec)
            let key = SessionKey(provider: "\(s.agent)-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + s.id)
            AppLog.info("native chat started")
            let stand = NativeAdapter.started(s)
            rememberStarted(stand)
            // The chat joins the broker's catalog now (a refresh already running when the host made it never lists it),
            // so its transcript is read and the sidebar and tabs show it; the person's first message shows at once.
            await broker.adopt(stand, adapterId: nativeAdapter.id)
            await broker.echo(spec.text ?? "", to: key)
            await broker.refresh()
            // The catalog event may land a moment after; the host's own row stands in meanwhile.
            let end = Date().addingTimeInterval(1)
            while Date() < end, !sessions.contains(where: { $0.key == key }) { try? await Task.sleep(for: .milliseconds(200)) }
            open(key)
            return (key, nil)
        } catch let e as NativeHostError {
            HeresayBridge.trouble()
            if case .uncertain = e { return (nil, "\(e.reason) Check the sidebar before starting it again.") }
            return (nil, e.reason)
        } catch {
            HeresayBridge.trouble()
            return (nil, "Squeak couldn't start the chat")
        }
    }
}
