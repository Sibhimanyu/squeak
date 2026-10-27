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
    var customizing = ProcessInfo.processInfo.environment["SQUEAK_MAC_NEWCHAT_CUSTOMIZE"] == "1"
    var phase: Phase = .loading
    var error: String?
    var focus = 0
    /// Images pasted, dropped or picked for the first message; written to the workspace only on Start chat.
    let images = ImageTray()
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    func prepare(model: AppModel, preselect: String?) {
        let known = form.models
        form = NewChatForm(workspaces: form.workspaces, preselect: preselect ?? form.workspaceId, store: ChatChoiceStore())
        if !known.isEmpty { form.setModels(known) }
        form.text = ""
        form.query = ""
        error = nil
        images.clear()
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

    func start(model: AppModel, openInWindow: Bool = true, close: @escaping () -> Void) {
        guard form.canStart, phase == .ready, let w = form.selected else { return }
        phase = .starting
        error = nil
        // The images go into the workspace's folder now; if that fails nothing starts and text and thumbnails stay.
        guard let text = images.prepareToSend(text: form.trimmedText, folder: w.path) else { phase = .ready; return }
        let agent = form.agent, extra = form.request
        let hadImages = images.hasImages
        Task { [weak self] in
            let result = await model.startChat(workspaceId: w.id, agent: agent, text: text,
                                               model: extra.model, thinking: extra.thinking, split: extra.split,
                                               openInWindow: openInWindow)
            guard let self else { return }
            switch result {
            case .started: phase = .ready; if hadImages { images.clear() }; close()
            case .failed(let reason), .uncertain(let reason): phase = .ready; error = reason // text stays, nothing is lost
            }
        }
    }
}

struct NewChatSheet: View {
    static let width: CGFloat = 580
    var close: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(NewChatState.self) private var state

    var body: some View {
        @Bindable var state = state
        VStack(alignment: .leading, spacing: 14) {
            Text("New chat").font(.system(size: Metrics.pageTitle, weight: .bold))
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
        .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 16)
        .frame(width: Self.width)
    }

    private func notice(_ text: String) -> some View {
        Text(text).font(Typo.body).foregroundStyle(Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 120, alignment: .leading)
    }

    @ViewBuilder private var form: some View {
        @Bindable var state = state
        let busy = state.phase == .starting
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Workspace").font(.system(size: 13, weight: .semibold))
                Spacer()
                if let repos = model.workspaceRepos, !repos.isEmpty {
                    if state.makingWorkspace {
                        ProgressView().controlSize(.small)
                        Text("Making a workspace…").font(Typo.meta).foregroundStyle(Theme.muted)
                    } else {
                        Menu {
                            ForEach(repos) { repo in
                                Button(repo.name) { state.createWorkspace(model: model, repoId: repo.id) }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Text("New workspace").font(.system(size: 13)).foregroundStyle(Theme.ink)
                                Lucide(.chevronDown, size: 13, color: Theme.ink)
                            }
                        }
                        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
                        .disabled(busy)
                        .help("Make a fresh workspace in a repository, branched from its default branch")
                    }
                }
            }
            .task { if model.workspaceRepos == nil { await model.loadWorkspaceRepos() } }
            searchField
            workspaceList.disabled(busy)
        }
        setupSection.disabled(busy)
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("First message").font(.system(size: 12)).foregroundStyle(Theme.muted)
                Spacer()
                if state.form.selected?.path != nil { AttachButton(tray: state.images, size: 22).disabled(busy) }
            }
            ImageStrip(tray: state.images)
            ComposerField(
                text: $state.form.text, sendKey: .commandReturnSends, placeholder: "What should it work on?",
                isEnabled: !busy, focusToken: state.focus, onSend: start, onEscape: close,
                onImages: busy || state.form.selected?.path == nil ? nil : { state.images.add($0) })
                .frame(height: 72)
                .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.card))
                .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
                .imageDrop(state.images)
            if state.form.isTooLong {
                Text("That's over \(NewChatForm.maxLength.formatted()) characters. Shorten it to start.")
                    .font(Typo.meta).foregroundStyle(Theme.error)
            }
        }
    }

    private var searchField: some View {
        @Bindable var state = state
        return HStack(spacing: 8) {
            Lucide(.search, size: Metrics.iconSmall, color: Theme.muted)
            TextField("Search workspaces", text: $state.form.query).textFieldStyle(.plain).font(.system(size: 13))
        }
        .padding(.horizontal, 10).frame(height: Metrics.field)
        .background(Theme.surfaceRaised.opacity(0.3), in: RoundedRectangle(cornerRadius: Radius.card - 2))
        .overlay(RoundedRectangle(cornerRadius: Radius.card - 2).strokeBorder(Theme.line))
    }

    /// Presets and their one-line summary, then Customize: agent, model, thinking, split, plan first.
    @ViewBuilder private var setupSection: some View {
        @Bindable var state = state
        let f = state.form
        VStack(alignment: .leading, spacing: 8) {
            if !f.presets.isEmpty {
                HStack(spacing: 8) {
                    ForEach(f.presets + (f.preset == .custom ? [.custom] : []), id: \.self) { p in
                        let on = f.preset == p
                        Button { if p != .custom { state.form.apply(preset: p) } } label: {
                            Text(p.title)
                                .font(.system(size: 13, weight: on ? .semibold : .regular))
                                .foregroundStyle(on ? Theme.ink : Theme.muted)
                                .frame(maxWidth: .infinity, minHeight: Metrics.field, maxHeight: Metrics.field)
                                .background(on ? Theme.lineStrong : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                                .padding(2)
                                .overlay(RoundedRectangle(cornerRadius: Radius.card - 2).strokeBorder(Theme.lineStrong.opacity(0.8)))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
            }
            if !f.models.isEmpty {
                Text(f.summary).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            customizeCard.padding(.top, 8).padding(.horizontal, -6)
        }
    }

    private var customizeCard: some View {
        @Bindable var state = state
        let f = state.form
        return VStack(alignment: .leading, spacing: 0) {
            Button { withAnimation(.easeOut(duration: 0.15)) { state.customizing.toggle() } } label: {
                HStack {
                    Text("Customize").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
                    Spacer()
                    Lucide(state.customizing ? .chevronDown : .chevronRight, size: 13, color: Theme.muted)
                }
                .padding(.horizontal, 12).frame(height: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if state.customizing {
                NCHairline()
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 12) {
                        column("Agent") {
                            NCPopup(label: "Agent", selection: Binding(get: { state.form.agent }, set: { state.form.choose(agent: $0) }),
                                    options: NewChatAgent.allCases.map { ($0, $0.displayName) })
                        }
                        if !f.agentModels.isEmpty {
                            column("Model") {
                                NCPopup(label: "Model", selection: Binding(get: { state.form.setup.modelId ?? "" }, set: { state.form.pick(modelId: $0) }),
                                        options: f.agentModels.map { m in (m.id, ChatPresets.shortName(m.label) + (m.label.contains("1M") ? " · 1M" : "")) })
                            }
                            if let chosen = f.chosenModel, !chosen.levels.isEmpty {
                                column("Thinking level") {
                                    NCSegmented(options: chosen.levels.map { ($0, DaemonChatModel.levelName($0)) },
                                                selection: state.form.setup.level ?? "") { state.form.pick(level: $0) }
                                }
                            }
                        }
                    }
                    if f.canSplit {
                        NCHairline()
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Split the work").font(.system(size: 13, weight: .semibold))
                            Text("The chat's model plans and reviews; cheaper ones do the typing.")
                                .font(.system(size: 12)).foregroundStyle(Theme.muted)
                        }
                        HStack(alignment: .top, spacing: 12) {
                            column("Writes the code") { workerPicker(\.setup.code, label: "Writes the code") { state.form.pick(code: $0) } }
                            column("Runs tests and builds") { workerPicker(\.setup.run, label: "Runs tests and builds") { state.form.pick(run: $0) } }
                        }
                        NCHairline()
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Plan first").font(.system(size: 13, weight: .semibold))
                                Text("Shows you the plan and waits for your go.").font(.system(size: 12)).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Toggle("Plan first", isOn: Binding(get: { state.form.setup.planFirst }, set: { state.form.set(planFirst: $0) }))
                                .labelsHidden().toggleStyle(.switch)
                        }
                    }
                }
                .padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 12)
            }
        }
        .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: Radius.card + 2))
        .overlay(RoundedRectangle(cornerRadius: Radius.card + 2).strokeBorder(Theme.lineStrong.opacity(0.8)))
    }

    private func column<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12)).foregroundStyle(Theme.muted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func workerPicker(_ path: KeyPath<NewChatForm, String?>, label: String, set: @escaping (String?) -> Void) -> some View {
        NCPopup(label: label, selection: Binding(get: { state.form[keyPath: path] ?? "" }, set: { set($0.isEmpty ? nil : $0) }),
                options: [("", "Same model")] + ChatWorker.all.map { ($0.id, $0.label) })
    }

    private var workspaceList: some View {
        let rows = state.form.filtered
        return ScrollView {
            LazyVStack(spacing: 0) {
                if rows.isEmpty {
                    Text(state.form.workspaces.isEmpty ? "No open workspaces in Conductor." : "No workspace matches.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 60)
                }
                ForEach(Array(rows.enumerated()), id: \.element.id) { i, w in
                    let on = w.id == state.form.workspaceId
                    if i > 0 { NCHairline() }
                    Button { state.form.select(w.id) } label: {
                        HStack(spacing: 0) {
                            ZStack { if on { Lucide(.check, size: Metrics.icon, color: Theme.ink) } }.frame(width: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: w.label).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                                if let t = w.title { Text(t).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1) }
                            }
                            Spacer(minLength: 0)
                            RelativeTimeText(w.lastActivityAt).font(.system(size: 11)).foregroundStyle(Theme.muted)
                        }
                        .padding(.trailing, 12).padding(.vertical, 5)
                        .frame(minHeight: 32)
                        .background(on ? Theme.selected : .clear)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
        }
        .frame(height: 168)
        .clipShape(RoundedRectangle(cornerRadius: Radius.card - 2))
        .overlay(RoundedRectangle(cornerRadius: Radius.card - 2).strokeBorder(Theme.lineStrong.opacity(0.8)))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            if let e = state.error {
                HStack(alignment: .top, spacing: 6) {
                    Lucide(.triangleAlert, size: Metrics.icon, color: Theme.error)
                    Text(e).font(Typo.body).foregroundStyle(Theme.error).fixedSize(horizontal: false, vertical: true)
                }
            }
            NCHairline().padding(.horizontal, -6)
            HStack(spacing: 12) {
                if state.phase == .starting { ProgressView().controlSize(.small); Text("Starting…").font(Typo.meta).foregroundStyle(Theme.muted) }
                else if state.phase == .ready {
                    NCKeycap()
                    Text("starts").font(.system(size: 12)).foregroundStyle(Theme.subtle)
                }
                Spacer()
                Button("Cancel") { close() }.buttonStyle(NCFooterButtonStyle(primary: false)).keyboardShortcut(.cancelAction)
                Button("Start chat") { start() }
                    .buttonStyle(NCFooterButtonStyle(primary: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!state.form.canStart || state.phase != .ready || !model.isConnected)
            }
            .padding(.top, 4)
        }
    }

    private func start() { state.start(model: model, close: close) }
}

private struct NCFooterButtonStyle: ButtonStyle {
    var primary: Bool
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        let fill: Color = primary ? (isEnabled ? (configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill) : Theme.surfaceRaised) : Theme.surfaceRaised.opacity(0.5)
        configuration.label
            .font(.system(size: 13, weight: primary ? .semibold : .regular))
            .foregroundStyle(primary ? (isEnabled ? Theme.primaryText : Theme.muted) : Theme.ink)
            .padding(.horizontal, primary ? 18 : 16)
            .frame(minHeight: Metrics.field)
            .background(fill, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay { if !primary || !isEnabled { RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line) } }
    }
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
                   model: String? = nil, thinking: String? = nil, split: WorkSplit? = nil,
                   openInWindow: Bool = true) async -> StartChatResult {
        if demoMode { return .failed(reason: "Demo data: nothing is started.") }
        let result = await client.startChat(workspaceId: workspaceId, agent: agent, text: text, model: model, thinking: thinking, split: split)
        if case .started(let sessionId) = result {
            AppLog.info("new chat started")
            if openInWindow { openWhenListed(sessionId: sessionId) }
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
