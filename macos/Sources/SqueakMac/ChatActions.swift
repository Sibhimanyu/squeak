import AppKit
import SqueakMacCore

/// The conversation window's chat actions, all through the daemon: change the model, Stop a stuck turn, ask for
/// a PR, archive the workspace, make a new one. Each says why when it did not happen.
extension AppModel {
    /// Reads the open chat's extras; called while its window is on screen.
    func refreshChatExtras(_ session: HostSession) async {
        guard let id = session.conductorSessionId else { chatExtras = nil; return }
        if demoMode {
            chatExtras = DemoData.chatExtras(for: session)
            if chatModels.isEmpty { chatModels = DemoData.chatModels }
            if workspaceRepos == nil { workspaceRepos = DemoData.repos }
            return
        }
        let next = await client.chatExtras(conductorSessionId: id)
        guard selectedSession?.conductorSessionId == id else { return }
        if next != chatExtras { chatExtras = next }
        if chatModels.isEmpty, next?.modelId != nil { chatModels = await client.chatModels() }
        if workspaceRepos == nil { workspaceRepos = await client.workspaceRepos() }
    }

    private func runChatAction(_ work: () async -> String?) async {
        guard !chatBusy else { return }
        chatBusy = true
        defer { chatBusy = false }
        chatNote = demoMode ? "Demo data: nothing is changed." : await work()
    }

    /// A new model, thinking level or fast mode for the chat, as Conductor's own picker sets it.
    func changeSetup(_ session: HostSession, model: String, thinking: String? = nil, fast: Bool? = nil) async {
        guard let id = session.conductorSessionId else { return }
        var body: [String: any Sendable] = ["model": model]
        if let thinking { body["thinking"] = thinking }
        if let fast { body["fast"] = fast }
        await runChatAction { await client.chatAction(sessionId: id, action: "setup", body: body) }
        await refreshChatExtras(session)
    }

    /// Conductor's Stop for the chat's turn.
    func stopChat(_ session: HostSession) async {
        guard let id = session.conductorSessionId else { return }
        await runChatAction { await client.chatAction(sessionId: id, action: "stop") }
    }

    /// Asks a resting chat to open a pull request.
    func askForPullRequest(_ session: HostSession) async {
        guard let id = session.conductorSessionId else { return }
        await runChatAction { await client.chatAction(sessionId: id, action: "pr") }
    }

    /// Archives the chat's workspace in Conductor, after asking.
    func archiveWorkspace(_ session: HostSession) async {
        guard let workspaceId = chatExtras?.workspaceId ?? session.conductorWorkspaceId else { return }
        let alert = NSAlert()
        alert.messageText = "Archive this workspace?"
        alert.informativeText = "Conductor stops its chats and removes the worktree; the branch and its commits stay, and you can restore it in Conductor. Squeak refuses while anything in it is uncommitted."
        alert.addButton(withTitle: "Archive")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        await runChatAction { await client.workspaceAction(["action": "archive", "workspaceId": workspaceId]).problem }
    }

    /// Makes a workspace in a repository (branched from its default branch). Its id, or why not.
    func createWorkspace(repoId: String) async -> (id: String?, problem: String?) {
        if demoMode { return (nil, "Demo data: no workspace is made.") }
        let outcome = await client.workspaceAction(["action": "create", "repoId": repoId])
        return (outcome.workspaceId, outcome.problem)
    }

    /// The repositories for New chat's New workspace menu.
    func loadWorkspaceRepos() async {
        if demoMode { workspaceRepos = DemoData.repos; return }
        workspaceRepos = await client.workspaceRepos()
    }
}
