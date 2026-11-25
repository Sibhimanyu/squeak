import AppKit
import SqueakMacCore
import SwiftUI

/// Open a repository folder or clone one: the Create menu in the sidebar and the File menu share these, so
/// both work with the sidebar hidden. A problem is told in an alert (the sidebar had a field for it).
@MainActor @Observable
final class ProjectActions {
    static let shared = ProjectActions()
    private(set) var busy = false

    func open(_ model: AppModel) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Open as pond"
        panel.message = "Choose a git repository. It becomes a pond, and its worktrees appear in the sidebar."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        busy = true
        Task {
            let (project, problem) = await model.nativeAddProject(path: url.path)
            await finish(model, project, problem ?? "Squeak couldn't open that repository.")
        }
    }

    func clone(_ model: AppModel) {
        busy = true
        Task {
            // Which GitHub sign-in this uses, as the host reports it (nothing is claimed when it cannot say).
            let signIn = model.demoMode ? nil : try? await model.nativeHost.githubSignIn()
            busy = false
            let base = "owner/repo from GitHub, or a repository address. It goes to ~/squeak/repos."
            guard let url = TextPrompt.ask(
                title: "Clone a repository", message: [base, CloneSignIn.line(signIn)].compactMap { $0 }.joined(separator: "\n\n"),
                placeholder: "owner/repo")
            else { return }
            if !model.demoMode, let s = try? await model.nativeHost.githubSignIn(repo: url), CloneSignIn.asksBeforeCloning(s) {
                let alert = NSAlert()
                alert.messageText = CloneSignIn.privateQuestion(repo: s.repo, login: s.login)
                alert.informativeText = CloneSignIn.privateMessage(login: s.login)
                alert.addButton(withTitle: CloneSignIn.cloneButton)
                alert.addButton(withTitle: "Cancel")
                guard alert.runModal() == .alertFirstButtonReturn else { return }
            }
            busy = true
            let (project, problem) = await model.nativeCloneProject(url: url)
            await finish(model, project, problem ?? "Squeak couldn't clone that repository.")
        }
    }

    /// Clones from the Create page: the result and a plain problem are the page's to show, so no alert.
    func clone(_ model: AppModel, url: String, name: String? = nil) async -> (NativeProject?, String?) {
        busy = true
        let (project, problem) = await model.nativeCloneProject(url: url, name: name)
        busy = false
        if let project { await refresh(model, project) }
        return (project, project == nil ? (problem ?? "Squeak couldn't clone that repository.") : nil)
    }

    /// Opens a folder from the New pond page: the result and a plain problem are the page's to show, so no alert.
    func add(_ model: AppModel, path: String, name: String? = nil) async -> (NativeProject?, String?) {
        busy = true
        let (project, problem) = await model.nativeAddProject(path: path, name: name)
        busy = false
        if let project { await refresh(model, project) }
        return (project, project == nil ? (problem ?? "Squeak couldn't open that repository.") : nil)
    }

    private func finish(_ model: AppModel, _ project: NativeProject?, _ problem: String) async {
        busy = false
        guard let project else {
            let alert = NSAlert()
            alert.messageText = "Couldn't open the pond"
            alert.informativeText = problem
            alert.runModal()
            return
        }
        await refresh(model, project)
    }

    private func refresh(_ model: AppModel, _ project: NativeProject) async {
        await model.refreshNativeProjects()
        await model.refreshNativeWorkspaces()
        // A project opened again appears unfolded.
        let key = "sidebarFolded"
        let folded = (UserDefaults.standard.string(forKey: key) ?? "").split(separator: "\n").map(String.init).filter { $0 != project.name }
        UserDefaults.standard.set(folded.joined(separator: "\n"), forKey: key)
    }
}
