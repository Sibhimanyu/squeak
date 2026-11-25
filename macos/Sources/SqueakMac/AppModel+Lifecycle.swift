import Foundation
import SqueakMacCore

// What the app does when the host's list or projects change, and the loops it owns for its whole life. None of this
// belongs to a view: a view that mounts later must not start a loop, nor miss a change that happened before it.
extension AppModel {
    /// The host's list changed. Only a real change of its keys (or which are archived) does anything: saved tabs and
    /// docked threads of chats that are gone are forgotten, the directory is read again, a chat waited on is opened.
    func sessionsListChanged() {
        let old = sessionSet.value
        let sig = SessionSetSignature(hostSessions)
        guard sessionSet.update(sig) else { return }
        sessionKeysRevision = sessionSet.revision
        updateDirectorySignature()
        guard SessionSetDiff.shouldPrune(sig) else { return }
        pruneTabs()
        let dock = DockStore.shared
        dock.pruneThreads(keeping: Set(sig.keys.map(\.stringValue)))
        dock.pruneDucklings(keeping: sig.keys)
        dock.pruneWorkspaces(keeping: Set(allSessions.map(SidebarTreeBuilder.workspaceKey)))
        if !awaitingList.isEmpty, !SessionSetDiff.delta(from: old, to: sig).added.isEmpty {
            Task { @MainActor [weak self] in self?.openListedWaiters() }
        }
    }

    func nativeProjectsChanged() {
        nativeProjectsRevision &+= 1
        updateDirectorySignature()
    }

    private func updateDirectorySignature() {
        let sig = native.projects.map(\.id) + sessionSet.value.keys.map(\.hostSessionId).filter { $0.hasPrefix("squeak-native:") }.sorted()
        if directorySignature.update(sig) { directoryRevision = directorySignature.revision }
    }

    /// Starts the polling loops once, for the app's life; each keeps its own `pollGate` behaviour (nothing while hidden).
    func startLoops() {
        guard loopTasks.isEmpty else { return }
        nativeProjectsChanged()
        restartLiveStepsLoop()
        loopTasks.append(Task { [weak self] in await self?.pollNativeWorkspaces() })
        guard !demoMode else { return }
        loopTasks.append(Task { [weak self] in await self?.pollNativeProjects() })
        loopTasks.append(Task { [weak self] in
            guard let self else { return }
            await PondOrderStore.shared.load(host: nativeHost)
        })
        loopTasks.append(Task { [weak self] in
            guard let self else { return }
            await PondsModel.shared.run(host: nativeHost)
        })
    }

    /// The live phrases are read again the moment the first catalog has landed.
    func restartLiveStepsLoop() {
        liveStepsTask?.cancel()
        liveStepsTask = Task { [weak self] in await self?.pollLiveSteps() }
    }
}
