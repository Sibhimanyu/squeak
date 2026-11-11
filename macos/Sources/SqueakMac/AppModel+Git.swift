import AppKit
import Foundation
import Observation
import SqueakMacCore

// DESIGN.md §8.10, git and workspace lifecycle for chats Squeak runs itself: the header's cluster, the PR tab, the
// workspace menu, project settings. The host decides everything (src/native/git-actions.ts); this only asks and draws.

struct MergeConfirm: Identifiable, Equatable {
    var id: String { hostId }
    var hostId: String
    var pr: NativePullRequest
    var base: String
    var method: String
}

struct LogSheet: Identifiable, Equatable {
    var id: String { workspaceId }
    var workspaceId: String
    var name: String
}

@MainActor @Observable
final class GitModel {
    struct Entry: Equatable {
        var status: NativeGitStatus?
        var loaded = false
    }

    /// By host session id.
    private(set) var entries: [String: Entry] = [:]
    var busy: GitActionKind?
    var mergeConfirm: MergeConfirm?
    var mergeError: String?
    var merging = false
    var logSheet: LogSheet?
    /// The workspaces of every project, and the run script's state of each ready one.
    var workspaces: [NativeWorkspace] = []
    var runs: [String: NativeRunStatus] = [:]
    @ObservationIgnored var lastRead: [String: Date] = [:]
    @ObservationIgnored var reading: Set<String> = []

    func entry(_ id: String) -> Entry { entries[id] ?? Entry() }
    func set(_ id: String, _ status: NativeGitStatus?) {
        var e = entries[id] ?? Entry()
        if e.status != status { e.status = status }
        e.loaded = true
        if entries[id] != e { entries[id] = e }
    }

    func workspace(path: String?) -> NativeWorkspace? {
        guard let path, !path.isEmpty else { return nil }
        return workspaces.first { $0.path == path }
    }
}

extension AppModel {
    /// The host's id of a chat Squeak runs itself; nil for any other.
    func hostId(_ s: HostSession) -> String? { s.source == .squeak ? NativeAdapter.nativeId(s) : nil }

    // MARK: Status

    /// Reads the chat's git state when the policy says so, never twice at once. A chat with no Squeak workspace (the
    /// host answers 400) has no cluster and no PR tab content.
    func refreshGit(_ s: HostSession, visible: Bool, activityChanged: Bool = false) async {
        guard !demoMode, !captureMode, let id = hostId(s), !git.reading.contains(id),
              GitPresentation.shouldRefresh(visible: visible, activityChanged: activityChanged, lastRead: git.lastRead[id], now: Date())
        else { return }
        git.reading.insert(id)
        defer { git.reading.remove(id) }
        let read = try? await nativeHost.gitStatus(sessionId: id)
        git.lastRead[id] = Date()
        git.set(id, read)
    }

    func gitStatus(_ s: HostSession) -> NativeGitStatus? { hostId(s).flatMap { git.entry($0).status } }

    // MARK: Actions

    /// Sends the action's prompt to the chat; it shows as the person's own message, like any send. Merge asks first.
    func runGitAction(_ s: HostSession, _ kind: GitActionKind) {
        guard let id = hostId(s), git.busy == nil else { return }
        if kind == .merge { askMerge(s); return }
        if demoMode { native.note = "Demo data: nothing is sent."; return }
        git.busy = kind
        native.note = nil
        Task { [weak self] in
            guard let self else { return }
            defer { git.busy = nil }
            do {
                let r = try await nativeHost.gitAction(sessionId: id, action: kind)
                AppLog.info("native git action sent")
                await broker.refreshTranscript()
                git.lastRead[id] = nil
                // A review on its own model runs in a new chat: show it.
                if let started = r.sessionId { await openStartedChat(hostSessionId: started) }
            } catch let e as NativeHostError {
                native.note = e.reason
            } catch {
                native.note = "Squeak couldn't send that"
            }
        }
    }

    /// The confirm sheet names the PR, the method (the project's own) and where it lands.
    func askMerge(_ s: HostSession) {
        guard let id = hostId(s), let status = git.entry(id).status, let pr = status.pr, GitPresentation.isEnabled(.merge, status) else { return }
        if demoMode { native.note = "Demo data: nothing is merged."; return }
        Task { [weak self] in
            guard let self else { return }
            var method = "squash"
            if let ws = git.workspace(path: s.cwd), let settings = try? await nativeHost.projectSettings(projectId: ws.projectId) {
                method = settings.effective.mergeMethod
            }
            git.mergeError = nil
            git.mergeConfirm = MergeConfirm(hostId: id, pr: pr, base: status.base, method: method)
        }
    }

    func confirmMerge() {
        guard let confirm = git.mergeConfirm, !git.merging else { return }
        git.merging = true
        git.mergeError = nil
        Task { [weak self] in
            guard let self else { return }
            defer { git.merging = false }
            do {
                _ = try await nativeHost.merge(sessionId: confirm.hostId)
                AppLog.info("native pull request merged")
                git.mergeConfirm = nil
                git.lastRead[confirm.hostId] = nil
                if let s = selectedSession, hostId(s) == confirm.hostId { await refreshGit(s, visible: true, activityChanged: true) }
            } catch let e as NativeHostError {
                git.mergeError = e.reason
            } catch {
                git.mergeError = "Squeak couldn't merge"
            }
        }
    }

    func openPullRequest(_ s: HostSession) {
        if let status = gitStatus(s), let url = GitPresentation.prURL(status) { NSWorkspace.shared.open(url) }
    }

    // MARK: Workspaces

    /// The host's workspaces (every project's) and each ready one's run state; the sidebar's loop calls it.
    func refreshNativeWorkspaces() async {
        guard !demoMode, !captureMode else { return }
        var all: [NativeWorkspace] = []
        var reached = false
        for p in native.projects {
            if let list = try? await nativeHost.workspaces(projectId: p.id) { all += list; reached = true }
        }
        guard reached || native.projects.isEmpty else { return }
        if all != git.workspaces { git.workspaces = all }
        var runs: [String: NativeRunStatus] = [:]
        for w in all where w.state == "ready" {
            if let r = try? await nativeHost.runStatus(workspaceId: w.id) { runs[w.id] = r }
        }
        if runs != git.runs { git.runs = runs }
    }

    func nativeWorkspace(of workspace: SidebarWorkspace) -> NativeWorkspace? {
        guard let cwd = workspace.chats.first(where: { $0.source == .squeak })?.cwd else { return nil }
        return git.workspace(path: cwd)
    }

    func toggleRun(_ ws: NativeWorkspace) {
        let start = !(git.runs[ws.id]?.running ?? false)
        Task { [weak self] in
            guard let self else { return }
            do { git.runs[ws.id] = try await nativeHost.setRun(workspaceId: ws.id, start: start) }
            catch let e as NativeHostError { Self.alert("Can't \(start ? "start" : "stop") the run script", e.reason) }
            catch { Self.alert("Can't \(start ? "start" : "stop") the run script", "Squeak couldn't reach its session host") }
        }
    }

    func openLocalhost(_ ws: NativeWorkspace) {
        if let url = WorkspaceLifecycle.localhostURL(port: git.runs[ws.id]?.port ?? ws.port) { NSWorkspace.shared.open(url) }
    }

    /// Confirm, then the host's own refusals in a sentence. A dirty tree is explained and can be archived anyway.
    func archiveNativeWorkspace(_ ws: NativeWorkspace) {
        if demoMode { Self.alert("Demo data", "Nothing is archived."); return }
        let first = NSAlert()
        first.messageText = "Archive \(ws.displayTitle)?"
        first.informativeText = "Squeak stops its run script, runs the archive script and removes the worktree folder. The branch and its commits stay."
        first.addButton(withTitle: "Archive")
        first.addButton(withTitle: "Cancel")
        first.buttons.first?.hasDestructiveAction = true
        guard first.runModal() == .alertFirstButtonReturn else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                _ = try await nativeHost.archive(workspaceId: ws.id)
            } catch {
                switch WorkspaceLifecycle.refusal(error) {
                case .other(let why): Self.alert("Can't archive \(ws.displayTitle)", why); return
                case .uncommitted:
                    let second = NSAlert()
                    second.messageText = "\(ws.displayTitle) has changes that aren't committed"
                    second.informativeText = "Archiving removes the folder and those changes with it. Commit and push first to keep them."
                    second.addButton(withTitle: "Cancel")
                    second.addButton(withTitle: "Archive anyway")
                    second.buttons.last?.hasDestructiveAction = true
                    guard second.runModal() == .alertSecondButtonReturn else { return }
                    do { _ = try await nativeHost.archive(workspaceId: ws.id, force: true) }
                    catch {
                        Self.alert("Can't archive \(ws.displayTitle)", (error as? NativeHostError)?.reason ?? "Squeak couldn't archive it")
                        return
                    }
                }
            }
            AppLog.info("native workspace archived")
            await refreshNativeWorkspaces()
            await broker.refresh()
        }
    }

    private static func alert(_ title: String, _ text: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        a.addButton(withTitle: "OK")
        a.runModal()
    }

    /// The host's project behind a sidebar project row.
    func nativeProject(named name: String) -> NativeProject? { NativeWorkspaceMaking.project(named: name, in: native.projects) }
}
