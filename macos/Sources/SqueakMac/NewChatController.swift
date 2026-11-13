import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// What the New thread page opens on after a branch was made, or a branch's "+" was pressed.
struct NativeSheetPreset: Equatable {
    var projectId: String
    var workspaceId: String?
    var error: String?
    /// A suggested first message (a branch made from an issue); only fills an empty message box.
    var text: String? = nil
}

/// The desktop window owns its creation pages: New pond, New branch, New thread (DESIGN.md "Create") and the
/// quick message. The menu-bar popup uses PopupNav and its own state.
@MainActor @Observable
final class NewChatController {
    static let shared = NewChatController()
    enum Page: Equatable {
        case quickMessage, newPond, newBranch, newThread
        /// The sidebar's top "Create" row is the New pond page.
        static let create = Page.newPond
        static let newChat = Page.newThread
    }
    var page: Page?
    let quickState = QuickState()
    let pond = NewPondState()
    let branch = NewBranchState()
    let thread = NewThreadState()

    func open(_ route: NewPage, text: String? = nil, error: String? = nil, pondThread: PondThreadContext? = nil) {
        let model = AppModel.shared
        hide()
        model.closeSettings()
        if model.navFilter == .usage { model.navFilter = .all }
        PondsModel.shared.route = nil
        // Threads and streams live in a pond: with none yet, the page that makes one opens instead.
        let (route, needsPond) = NewPages.resolve(route, hasPond: model.hasPonds)
        switch route {
        case .pond:
            pond.reset()
            pond.notice = needsPond ? NewPages.makePondFirst : nil
            page = .newPond
        case .branch(let projectId, let source):
            branch.prepare(model: model, projectId: projectId, preset: source)
            if let error { branch.error = error }
            page = .newBranch
        case .thread(let projectId, let workspaceId):
            thread.prepare(model: model, route: route, projectId: projectId, workspaceId: workspaceId, text: text, error: error, pond: pondThread)
            page = .newThread
        case .conductorThread(let workspaceId):
            thread.prepare(model: model, route: route, conductorWorkspaceId: workspaceId)
            page = .newThread
        }
        model.showConversationWindow()
    }

    /// Opens New thread on a branch the host just made (or, with an error, on its pond).
    func show(nativePreset preset: NativeSheetPreset) {
        open(.thread(projectId: preset.projectId, workspaceId: preset.workspaceId), text: preset.text, error: preset.error)
    }

    /// ⌘N and the palette: New thread on the most recently active branch.
    func show(preselect conductorWorkspaceId: String? = nil) {
        if let id = conductorWorkspaceId { open(.conductorThread(workspaceId: id)) }
        else { open(NewPages.page(for: .newThreadShortcut)) }
    }

    func showCreate() { open(NewPages.page(for: .sidebarCreate)) }

    func showQuickMessage() {
        let model = AppModel.shared
        hide()
        model.closeSettings()
        quickState.prepare(model: model, explicit: model.selected)
        quickState.focus += 1
        page = .quickMessage
        model.showConversationWindow()
    }

    func hide() {
        if page == .quickMessage {
            quickState.stashDraft()
            quickState.epoch += 1
            quickState.context.clear()
        }
        page = nil
    }
}

extension AppModel {
    /// The sidebar's top "Create".
    func openNewPond() { NewChatController.shared.open(NewPages.page(for: .sidebarCreate)) }

    /// The "+" next to a pond.
    func openNewBranch(projectId: String, source: NewBranchPreset = .newFromDefault) {
        // A plain-folder pond has no streams (the palette and the shortcut still reach here): say so, make nothing.
        if native.projects.first(where: { $0.id == projectId })?.isPlainFolder == true {
            native.note = FolderPond.noStreams
            return
        }
        NewChatController.shared.open(NewPages.page(for: .pondPlus(projectId: projectId, source: source)))
    }

    /// The "+" on a branch. With no place named, the most recently active branch.
    func openNewThread(projectId: String? = nil, workspaceId: String? = nil) {
        if let projectId, let workspaceId {
            NewChatController.shared.open(NewPages.page(for: .branchPlus(projectId: projectId, workspaceId: workspaceId)))
        } else {
            NewChatController.shared.open(NewPages.page(for: .newThreadShortcut))
        }
    }

    /// The "+" on a Conductor workspace: a chat there, through the daemon.
    func openNewThread(conductorWorkspaceId: String) {
        NewChatController.shared.open(NewPages.page(for: .conductorWorkspacePlus(workspaceId: conductorWorkspaceId)))
    }
}

/// An integrated desktop page.
struct DesktopComposePage: View {
    let controller = NewChatController.shared

    var body: some View {
        switch controller.page {
        case .newThread:
            NewThreadPage(state: controller.thread)
        case .newBranch:
            NewBranchPage(state: controller.branch)
        case .newPond:
            NewPondPage(state: controller.pond)
        case .quickMessage:
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("Quick message").font(.system(size: Metrics.pageTitle, weight: .bold))
                    Spacer()
                    Button("Done") { controller.hide() }.buttonStyle(SecondaryButtonStyle())
                }
                Text("Send a message to an existing chat.").font(Typo.body).foregroundStyle(Theme.muted)
                QuickComposerView(close: { controller.hide() }, embedded: true)
                    .environment(controller.quickState)
                Spacer(minLength: 0)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        case nil:
            EmptyView()
        }
    }
}

// MARK: - AppModel

@MainActor enum PresetSyncGate {
    static var pending: Task<Void, Never>?
    static var running = false
}

enum NewChatWorkspaces { case success([NewChatWorkspace]), outdated, offline }

extension AppModel {
    /// Brings the Mac's copy of the new chat presets level with the daemon's (queued edits first, a one-time
    /// hand-over of presets customised before the daemon held them). With the daemon down the copy stands.
    @discardableResult
    func syncChatPresets() async -> Bool {
        if demoMode { return false }
        // A name is saved on every keystroke: send the burst once, after it settles.
        ChatPresetPreferences.onChange = { [weak self] in
            Task { @MainActor in
                PresetSyncGate.pending?.cancel()
                PresetSyncGate.pending = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(600))
                    guard !Task.isCancelled else { return }
                    await self?.syncChatPresets()
                }
            }
        }
        while PresetSyncGate.running { try? await Task.sleep(for: .milliseconds(100)) }
        PresetSyncGate.running = true
        defer { PresetSyncGate.running = false }
        return await ChatPresetSync.sync(client: client) == .synced
    }

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
