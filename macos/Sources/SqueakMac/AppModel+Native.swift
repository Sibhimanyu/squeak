import AppKit
import Foundation
import Observation
import SqueakMacCore

/// What the open Squeak-run chat shows beyond its transcript: the host's record of it, the card that waits on
/// the person, the text being written, the queue. One chat at a time (the one on screen).
@MainActor @Observable
final class NativeChatModel {
    var key: SessionKey?
    var info: NativeSession?
    var card: NativeCard?
    var streamingText = ""
    var queue: [NativeQueueItem] = []
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
    /// A deny's reason is typed into the composer; this is the last mode the person picked, shown at once.
    var modeOverride: ComposerMode?
    @ObservationIgnored var refreshTask: Task<Void, Never>?
    @ObservationIgnored var refreshAgain = false

    var mode: ComposerMode? {
        modeOverride ?? info.map { NativeModes.composerMode($0.permissionMode) }
    }

    func reset(_ key: SessionKey?) {
        self.key = key; info = nil; card = nil; streamingText = ""; queue = []; note = nil; queueNote = nil
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
        await refreshNative(s)
        if chatModels.isEmpty { chatModels = await client.chatModels() }
        let prefix = NativeAdapter.keyPrefix
        let hostId = key.hostSessionId.hasPrefix(prefix) ? String(key.hostSessionId.dropFirst(prefix.count)) : key.hostSessionId
        let newest = (try? await nativeHost.messages(id: hostId, before: nil, limit: 1))?.last?.seq ?? 0
        var live = NativeLiveState()
        for await event in nativeAdapter.events(for: s, after: newest) {
            if Task.isCancelled || native.key != key { break }
            let effect = live.apply(event)
            if native.streamingText != live.streamingText { native.streamingText = live.streamingText }
            switch event {
            case .request, .requestResolved:
                native.show(requests: live.requests, agent: agentName(s))
            case .status:
                if let info = try? await nativeAdapter.info(for: s), native.key == key { native.info = info }
                if live.status != "working" { await broker.nudge() }
                if native.key == key, let status = live.status, status != "needs_user_permission", status != "needs_plan_response", status != "needs_user_input" {
                    native.card = nil
                }
            case .queueChanged:
                _ = live.takeQueueDirty()
                await refreshNativeQueue(s)
            default: break
            }
            switch effect {
            case .transcriptChanged, .refetch: scheduleNativeRefresh()
            case .none: break
            }
        }
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
        await refreshNativeQueue(s)
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

    func refreshNativeQueue(_ s: HostSession) async {
        guard let c = nativeControls(for: s), let q = try? await c.queue(for: s), native.key == s.key else { return }
        if q != native.queue { native.queue = q }
    }

    // MARK: Cards

    private func nativeCardAction(_ s: HostSession, _ work: @escaping (any NativeChatControls, NativeCard) async -> NativeActionResult) {
        guard !native.busy, let card = native.card else { return }
        if demoMode { native.note = "Demo data: nothing is sent."; return }
        guard let c = nativeControls(for: s) else { return }
        native.busy = true
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            let result = await work(c, card)
            native.busy = false
            switch result {
            case .done:
                // The stream's request-resolved clears the card; clear it now too so a double press can't answer twice.
                if native.card?.id == card.id { native.card = nil }
            case .refused(let reason), .failed(let reason):
                native.note = reason
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

    func nativeSetModel(_ s: HostSession, modelId: String, effort: String?) {
        if demoMode { native.note = "Demo data: nothing is changed."; return }
        guard let c = nativeControls(for: s) else { return }
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            let r = await c.setModel(s, model: modelId, effort: effort)
            if case .refused(let why) = r { native.note = why }
            if case .failed(let why) = r { native.note = why }
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

    func nativeDeleteQueued(_ s: HostSession, _ item: NativeQueueItem) async -> Bool {
        guard let c = nativeControls(for: s) else { return false }
        native.queueNote = nil
        let r = await c.removeQueued(s, queueId: item.id)
        await refreshNativeQueue(s)
        if case .done = r { return true }
        if case .refused(let why) = r { native.queueNote = why }
        if case .failed(let why) = r { native.queueNote = why }
        return false
    }

    func nativeEditQueued(_ s: HostSession, _ item: NativeQueueItem, text: String) async {
        guard let c = nativeControls(for: s) else { return }
        native.queueNote = nil
        let r = await c.editQueued(s, queueId: item.id, text: text)
        if case .refused(let why) = r { native.queueNote = why }
        if case .failed(let why) = r { native.queueNote = why }
        await refreshNativeQueue(s)
    }

    func nativeSteerQueued(_ s: HostSession, _ item: NativeQueueItem) async {
        guard let c = nativeControls(for: s) else { return }
        native.queueNote = nil
        let r = await c.steerQueued(s, queueId: item.id)
        if case .refused(let why) = r { native.queueNote = NativeQueueNote.steerRefused(why, agent: agentName(s)) }
        if case .failed(let why) = r { native.queueNote = why }
        await refreshNativeQueue(s)
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

    /// Makes a bird-named worktree in a project through the host, then opens the New chat sheet preset to it. A
    /// failure opens the sheet on the project with the reason in a plain sentence, so nothing is lost.
    func nativeMakeWorkspace(projectId: String, from source: NativeWorkspaceSource? = nil, prompt: String? = nil) {
        guard native.makingWorkspaceIn == nil else { return }
        if demoMode { NewChatController.shared.show(nativePreset: NativeSheetPreset(projectId: projectId, error: "Demo data: no workspace is made.")); return }
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

    func nativeCloneProject(url: String) async -> (NativeProject?, String?) {
        if demoMode { return (nil, "Demo data: nothing is cloned.") }
        do { return (try await nativeHost.cloneProject(url: url), nil) }
        catch let e as NativeHostError { return (nil, e.reason) }
        catch { return (nil, "Squeak couldn't clone that repository") }
    }

    func nativeAddProject(path: String) async -> (NativeProject?, String?) {
        if demoMode { return (nil, "Demo data: no folder is added.") }
        do { return (try await nativeHost.addProject(rootPath: path), nil) }
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
            await broker.refresh()
            // The catalog event may land a moment after; give it a few seconds, then select either way.
            let end = Date().addingTimeInterval(5)
            while Date() < end, !sessions.contains(where: { $0.key == key }) { try? await Task.sleep(for: .milliseconds(200)) }
            open(key)
            return (key, nil)
        } catch let e as NativeHostError {
            if case .uncertain = e { return (nil, "\(e.reason) Check the sidebar before starting it again.") }
            return (nil, e.reason)
        } catch {
            return (nil, "Squeak couldn't start the chat")
        }
    }
}
