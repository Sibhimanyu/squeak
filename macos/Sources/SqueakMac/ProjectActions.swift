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
        guard let url = TextPrompt.ask(
            title: "Clone a repository", message: "owner/repo from GitHub, or a git URL. It goes to ~/squeak/repos.",
            placeholder: "owner/repo")
        else { return }
        busy = true
        Task {
            let (project, problem) = await model.nativeCloneProject(url: url)
            await finish(model, project, problem ?? "Squeak couldn't clone that repository.")
        }
    }

    /// Clones from the Create page: the result and a plain problem are the page's to show, so no alert.
    func clone(_ model: AppModel, url: String) async -> (NativeProject?, String?) {
        busy = true
        let (project, problem) = await model.nativeCloneProject(url: url)
        busy = false
        if let project { await refresh(model, project) }
        return (project, project == nil ? (problem ?? "Squeak couldn't clone that repository.") : nil)
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
