import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Opens New chat from anywhere: ⌘N, the popover footer, the quick composer. A borderless panel with the
/// menu-bar panel's own glass surface, dropped under the status item where that panel opens, so starting a
/// chat stays in the panel's look instead of opening a titled window.
@MainActor
final class NewChatController: NSObject {
    static let shared = NewChatController()
    private var panel: QuickPanel?
    private var clickMonitor: Any?
    let state = NewChatState()

    func show(preselect workspaceId: String? = nil) {
        let model = AppModel.shared
        if panel == nil {
            let p = QuickPanel(
                contentRect: NSRect(x: 0, y: 0, width: NewChatSheet.width, height: 640),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            p.isMovableByWindowBackground = true
            p.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
            p.onEscape = { [weak self] in self?.hide() }
            let host = NSHostingView(rootView: NewChatSheet(close: { [weak self] in self?.hide() })
                .panelSurface()
                .environment(model).environment(state))
            host.sizingOptions = [.intrinsicContentSize]
            p.contentView = host
            panel = p
        }
        state.prepare(model: model, preselect: workspaceId)
        guard let panel else { return }
        if !panel.isVisible { place(panel) }
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        watchOutsideClicks()
    }

    func hide() {
        if let clickMonitor { NSEvent.removeMonitor(clickMonitor) }
        clickMonitor = nil
        panel?.orderOut(nil)
    }

    /// Under the status item, like the menu-bar panel; on the pointer's screen, high, when there is none.
    private func place(_ panel: NSPanel) {
        let size = panel.contentView?.fittingSize ?? panel.frame.size
        if let frame = MenuBarController.shared.dropFrame(size: size) {
            panel.setFrame(frame, display: false)
            return
        }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let v = screen?.visibleFrame else { return panel.center() }
        panel.setFrame(CGRect(x: v.midX - size.width / 2, y: v.maxY - 12 - size.height, width: size.width, height: size.height), display: false)
    }

    /// A click in another app closes it, as it does the menu-bar panel.
    private func watchOutsideClicks() {
        guard clickMonitor == nil else { return }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.hide() }
        }
    }
}

@MainActor @Observable
final class NewChatState {
    enum Phase: Equatable { case loading, ready, starting, outdated, offline }

    var form = NewChatForm(store: ChatChoiceStore())
    var customizing = false
    var phase: Phase = .loading
    var error: String?
    var focus = 0
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    func prepare(model: AppModel, preselect: String?) {
        let known = form.models
        form = NewChatForm(workspaces: form.workspaces, preselect: preselect ?? form.workspaceId, store: ChatChoiceStore())
        if !known.isEmpty { form.setModels(known) }
        form.text = ""
        form.query = ""
        error = nil
        phase = form.workspaces.isEmpty ? .loading : .ready
        focus += 1
        loadTask?.cancel()
        loadTask = Task { [weak self] in
            // Models come with the sheet; an older daemon lists none and the chat starts as it always did.
            let listed = await model.newChatModels()
            if let self, !Task.isCancelled, !listed.isEmpty { form.setModels(listed) }
            let result = await model.newChatWorkspaces()
            guard let self, !Task.isCancelled else { return }
            switch result {
            case .success(let list):
                form.setWorkspaces(list)
                if let preselect { form.select(preselect) }
                phase = .ready
            case .outdated: phase = .outdated
            case .offline: if form.workspaces.isEmpty { phase = .offline }
            }
        }
    }

    /// A workspace is being made from the New workspace menu.
    var makingWorkspace = false

    /// Makes a workspace in a repository, then lists and selects it.
    func createWorkspace(model: AppModel, repoId: String) {
        guard !makingWorkspace else { return }
        makingWorkspace = true
        error = nil
        Task { [weak self] in
            let (id, problem) = await model.createWorkspace(repoId: repoId)
            guard let self else { return }
            if let id, case .success(let list) = await model.newChatWorkspaces() {
                form.setWorkspaces(list)
                form.query = ""
                form.select(id)
            } else {
                error = problem ?? "Squeak made the workspace, but it isn't listed yet."
            }
            makingWorkspace = false
        }
    }

    func start(model: AppModel, close: @escaping () -> Void) {
        guard form.canStart, phase == .ready, let w = form.selected else { return }
        phase = .starting
        error = nil
        let text = form.trimmedText, agent = form.agent, extra = form.request
        Task { [weak self] in
            let result = await model.startChat(workspaceId: w.id, agent: agent, text: text,
                                               model: extra.model, thinking: extra.thinking, split: extra.split)
            guard let self else { return }
            switch result {
            case .started: phase = .ready; close()
            case .failed(let reason), .uncertain(let reason): phase = .ready; error = reason // text stays, nothing is lost
            }
        }
    }
}

struct NewChatSheet: View {
    static let width: CGFloat = 520
    var close: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(NewChatState.self) private var state

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: Space.l) {
            Text("New chat").font(Typo.title)
            switch state.phase {
            case .loading:
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Loading workspaces…").foregroundStyle(Theme.muted) }
                    .frame(maxWidth: .infinity, minHeight: 200)
            case .offline:
                notice("Squeak can't reach its service, so there is nowhere to start a chat. Open Squeak for the fix.")
            case .outdated:
                notice("This version of the Squeak service can't start chats yet. Update the service in Settings.")
            case .ready, .starting:
                form
            }
            footer
        }
        .padding(20)
        .frame(width: Self.width)
    }

    private func notice(_ text: String) -> some View {
        Text(text).font(Typo.body).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
    }

    @ViewBuilder private var form: some View {
        @Bindable var state = state
        let busy = state.phase == .starting
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text("Workspace").font(Typo.label)
                Spacer()
                if let repos = model.workspaceRepos, !repos.isEmpty {
                    if state.makingWorkspace {
                        ProgressView().controlSize(.small)
                        Text("Making a workspace…").font(Typo.meta).foregroundStyle(Theme.muted)
                    } else {
                        Menu("New workspace") {
                            ForEach(repos) { repo in
                                Button(repo.name) { state.createWorkspace(model: model, repoId: repo.id) }
                            }
                        }
                        .menuStyle(.borderlessButton).fixedSize()
                        .disabled(busy)
                        .help("Make a fresh workspace in a repository, branched from its default branch")
                    }
                }
            }
            .task { if model.workspaceRepos == nil { await model.loadWorkspaceRepos() } }
            SearchField(text: $state.form.query, placeholder: "Search workspaces")
            workspaceList.disabled(busy)
        }
        setupSection.disabled(busy)
        VStack(alignment: .leading, spacing: Space.s) {
            Text("First message").font(Typo.label)
            ComposerField(
                text: $state.form.text, sendKey: .commandReturnSends, placeholder: "What should it work on?",
                isEnabled: !busy, focusToken: state.focus, onSend: start, onEscape: close)
                .frame(height: 110)
                .background(Theme.surfaceRaised.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            if state.form.isTooLong {
                Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.")
                    .font(Typo.meta).foregroundStyle(Theme.error)
            }
        }
    }

    /// Presets and their one-line summary, then Customize: agent, model, thinking, split, plan first.
    @ViewBuilder private var setupSection: some View {
        @Bindable var state = state
        let f = state.form
        VStack(alignment: .leading, spacing: Space.s) {
            if !f.presets.isEmpty {
                HStack(spacing: Space.s) {
                    ForEach(f.presets + (f.preset == .custom ? [.custom] : []), id: \.self) { p in
                        let on = f.preset == p
                        Button(p.title) { if p != .custom { state.form.apply(preset: p) } }
                            .buttonStyle(.plain)
                            .font(.system(size: 12.5, weight: on ? .semibold : .regular))
                            .foregroundStyle(on ? Theme.ink : Theme.muted)
                            .padding(.horizontal, Space.m).padding(.vertical, 5)
                            .background(on ? Theme.surfaceRaised : .clear, in: Capsule())
                            .overlay(Capsule().strokeBorder(Theme.line))
                            .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            if !f.models.isEmpty {
                Text(f.summary).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            DisclosureGroup(isExpanded: $state.customizing) {
                VStack(alignment: .leading, spacing: Space.s) {
                    LabeledContent("Agent") {
                        Picker("Agent", selection: Binding(get: { state.form.agent }, set: { state.form.choose(agent: $0) })) {
                            ForEach(NewChatAgent.allCases) { Text($0.displayName).tag($0) }
                        }
                        .pickerStyle(.segmented).labelsHidden().frame(width: 200)
                    }
                    if !f.agentModels.isEmpty {
                        LabeledContent("Model") {
                            Picker("Model", selection: Binding(get: { state.form.setup.modelId ?? "" }, set: { state.form.pick(modelId: $0) })) {
                                ForEach(f.agentModels) { m in
                                    Text(ChatPresets.shortName(m.label) + (m.label.contains("1M") ? " · 1M" : "")).tag(m.id)
                                }
                            }
                            .labelsHidden().fixedSize()
                        }
                        if let chosen = f.chosenModel, !chosen.levels.isEmpty {
                            LabeledContent("Thinking") {
                                Picker("Thinking", selection: Binding(get: { state.form.setup.level ?? "" }, set: { state.form.pick(level: $0) })) {
                                    ForEach(chosen.levels, id: \.self) { Text(DaemonChatModel.levelName($0)).tag($0) }
                                }
                                .labelsHidden().fixedSize()
                            }
                        }
                    }
                    if f.canSplit {
                        Text("Split the work").font(Typo.label).padding(.top, Space.xs)
                        LabeledContent("Writes the code") { workerPicker(\.setup.code) { state.form.pick(code: $0) } }
                        LabeledContent("Runs tests and builds") { workerPicker(\.setup.run) { state.form.pick(run: $0) } }
                        Text("The chat's model plans and reviews; cheaper ones do the typing.")
                            .font(Typo.meta).foregroundStyle(Theme.muted)
                        Toggle(isOn: Binding(get: { state.form.setup.planFirst }, set: { state.form.set(planFirst: $0) })) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text("Plan first")
                                Text("Shows you the plan and waits for your go.").font(Typo.meta).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                }
                .padding(.top, Space.s)
            } label: {
                Text("Customize").font(Typo.label)
            }
        }
    }

    private func workerPicker(_ path: KeyPath<NewChatForm, String?>, set: @escaping (String?) -> Void) -> some View {
        Picker("Worker", selection: Binding(get: { state.form[keyPath: path] ?? "" }, set: { set($0.isEmpty ? nil : $0) })) {
            Text("Same model").tag("")
            ForEach(ChatWorker.all) { Text($0.label).tag($0.id) }
        }
        .labelsHidden().fixedSize()
    }

    private var workspaceList: some View {
        let rows = state.form.filtered
        return ScrollView {
            LazyVStack(spacing: 2) {
                if rows.isEmpty {
                    Text(state.form.workspaces.isEmpty ? "No open workspaces in Conductor." : "No workspace matches.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 60)
                }
                ForEach(rows) { w in
                    let on = w.id == state.form.workspaceId
                    Button { state.form.select(w.id) } label: {
                        HStack(spacing: Space.s) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: w.label).font(.system(size: 13, weight: on ? .semibold : .regular)).foregroundStyle(Theme.ink).lineLimit(1)
                                if let t = w.title { Text(t).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1) }
                            }
                            Spacer(minLength: 0)
                            RelativeTimeText(w.lastActivityAt)
                            if on { Lucide(.check, size: 16, color: Theme.ink) }
                        }
                        .padding(.horizontal, Space.m).padding(.vertical, 6)
                        .background(on ? Theme.surfaceRaised : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        .frame(height: 150)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let e = state.error {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: 16, color: Theme.error)
                    Text(e).font(Typo.body).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: Space.s) {
                if state.phase == .starting { ProgressView().controlSize(.small); Text("Starting…").font(Typo.meta).foregroundStyle(Theme.muted) }
                else if state.phase == .ready { Text("⌘↩ starts").font(Typo.meta).foregroundStyle(Theme.subtle) }
                Spacer()
                Button("Cancel") { close() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Start chat") { start() }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
                    .disabled(!state.form.canStart || state.phase != .ready || !model.isConnected)
            }
        }
    }

    private func start() { state.start(model: model, close: close) }
}

// MARK: - AppModel

enum NewChatWorkspaces { case success([NewChatWorkspace]), outdated, offline }

extension AppModel {
    func newChatWorkspaces() async -> NewChatWorkspaces {
        if demoMode { return .success(NewChatDemo.workspaces()) }
        do {
            guard let list = try await client.newChatWorkspaces() else { return .outdated }
            return .success(list)
        } catch {
            return .offline
        }
    }

    /// The models a new chat can pick from; empty from an older daemon or when it can't be reached.
    func newChatModels() async -> [DaemonChatModel] {
        if demoMode { return DemoData.chatModels }
        if !chatModels.isEmpty { return chatModels }
        let list = await client.chatModels()
        if !list.isEmpty { chatModels = list }
        return list
    }

    /// A deliberate press of Start chat. On success the new chat opens as soon as the local reader lists it.
    func startChat(workspaceId: String, agent: NewChatAgent, text: String,
                   model: String? = nil, thinking: String? = nil, split: WorkSplit? = nil) async -> StartChatResult {
        if demoMode { return .failed(reason: "Demo data: nothing is started.") }
        let result = await client.startChat(workspaceId: workspaceId, agent: agent, text: text, model: model, thinking: thinking, split: split)
        if case .started(let sessionId) = result {
            AppLog.info("new chat started")
            openWhenListed(sessionId: sessionId)
        } else {
            AppLog.info("new chat not started")
        }
        return result
    }

    private func openWhenListed(sessionId: String) {
        Task { [weak self] in
            let end = Date().addingTimeInterval(15)
            while Date() < end {
                if let s = self?.sessions.first(where: { $0.key.hostSessionId == sessionId }) {
                    self?.open(s.key)
                    return
                }
                try? await Task.sleep(for: .milliseconds(300))
            }
            AppLog.info("new chat not listed within 15s")
        }
    }
}

enum NewChatDemo {
    static func workspaces(now: Date = Date()) -> [NewChatWorkspace] {
        [
            NewChatWorkspace(id: "w1", repoName: "orchard", branch: "fix/retry-logic", title: "Checkout retries", lastActivityAt: now.addingTimeInterval(-300), defaultAgent: .claude),
            NewChatWorkspace(id: "w2", repoName: "lighthouse", branch: "main", title: "Rate limiter", lastActivityAt: now.addingTimeInterval(-7200), defaultAgent: .codex),
            NewChatWorkspace(id: "w3", repoName: "orchard", branch: "docs/api", lastActivityAt: now.addingTimeInterval(-86400), defaultAgent: .claude),
            NewChatWorkspace(id: "w4", repoName: "squeak", branch: "test/login-flake", title: "Fix flaky login test", lastActivityAt: now.addingTimeInterval(-86400 * 3), defaultAgent: .codex),
        ]
    }
}
