import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Opens the New chat sheet from anywhere: ⌘N, the popover footer, the quick composer. It is a window
/// of its own, not a SwiftUI `.sheet`, because those entry points have no window to hang one on.
@MainActor
final class NewChatController: NSObject, NSWindowDelegate {
    static let shared = NewChatController()
    private var window: NSWindow?
    let state = NewChatState()

    func show(preselect workspaceId: String? = nil) {
        let model = AppModel.shared
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: NewChatSheet.width, height: 560),
                styleMask: [.titled, .closable], backing: .buffered, defer: false)
            w.title = "New chat"
            w.titlebarAppearsTransparent = true
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.contentView = NSHostingView(rootView: NewChatSheet(close: { [weak self] in self?.hide() }).environment(model).environment(state))
            window = w
        }
        state.prepare(model: model, preselect: workspaceId)
        ActivationPolicyController.shared.willShowWindow()
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func hide() { window?.orderOut(nil) }

    nonisolated func windowShouldClose(_ sender: NSWindow) -> Bool { true }
}

@MainActor @Observable
final class NewChatState {
    enum Phase: Equatable { case loading, ready, starting, outdated, offline }

    var form = NewChatForm()
    var phase: Phase = .loading
    var error: String?
    var focus = 0
    @ObservationIgnored private var loadTask: Task<Void, Never>?

    func prepare(model: AppModel, preselect: String?) {
        form = NewChatForm(workspaces: form.workspaces, preselect: preselect ?? form.workspaceId)
        form.text = ""
        form.query = ""
        error = nil
        phase = form.workspaces.isEmpty ? .loading : .ready
        focus += 1
        loadTask?.cancel()
        loadTask = Task { [weak self] in
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
        let text = form.trimmedText, agent = form.agent
        Task { [weak self] in
            let result = await model.startChat(workspaceId: w.id, agent: agent, text: text)
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
        .background(Theme.bg)
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
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Agent").font(Typo.label)
            Picker("Agent", selection: Binding(get: { state.form.agent }, set: { state.form.choose(agent: $0) })) {
                ForEach(NewChatAgent.allCases) { Text($0.displayName).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 200).disabled(busy)
        }
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

    /// A deliberate press of Start chat. On success the new chat opens as soon as the local reader lists it.
    func startChat(workspaceId: String, agent: NewChatAgent, text: String) async -> StartChatResult {
        if demoMode { return .failed(reason: "Demo data: nothing is started.") }
        let result = await client.startChat(workspaceId: workspaceId, agent: agent, text: text)
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
