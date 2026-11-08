import Foundation
import Observation
import SqueakMacCore

/// One chat's changes for the header diffstat and the inspector's Changes and Files tabs. It only reads from the
/// daemon (`/changes`, `/changes/file`); nothing here touches git or the folder. Reads are driven by the views
/// that show it, only while they are on screen (ChangesPresentation.shouldRefresh).
@MainActor @Observable
final class ChangesStore {
    enum Phase: Equatable { case loading, ready, unavailable }
    private(set) var changes: DaemonChanges?
    private(set) var phase: Phase = .loading
    private(set) var selectedPath: String?
    private(set) var patch: DaemonChangePatch?
    private(set) var patchLoading = false
    @ObservationIgnored private var lastRead: Date?
    @ObservationIgnored private var reading = false
    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    init(client: DaemonClient, demo: Bool) { self.client = client; self.demo = demo }

    /// Reads the list when the policy says so (`force` for an activity change); the open file's diff follows it.
    func refresh(sessionKey: String, visible: Bool, activityChanged: Bool = false) async {
        guard !demo, !reading,
              ChangesPresentation.shouldRefresh(visible: visible, activityChanged: activityChanged, lastRead: lastRead, now: Date())
        else { return }
        reading = true
        defer { reading = false }
        let read = try? await client.changes(sessionKey: sessionKey)
        lastRead = Date()
        guard let read else {
            // Older daemon, no folder, not a repository: nothing to draw, and nothing to say but "no changes".
            if changes != nil { changes = nil }
            phase = .unavailable
            return
        }
        if read != changes { changes = read }
        phase = .ready
        if let selectedPath {
            if read.files.contains(where: { $0.path == selectedPath }) {
                await loadPatch(sessionKey: sessionKey, path: selectedPath, quiet: true)
            } else {
                self.selectedPath = nil; patch = nil
            }
        }
    }

    func select(_ path: String?, sessionKey: String) async {
        if path == selectedPath { selectedPath = nil; patch = nil; return }
        selectedPath = path; patch = nil
        if let path { await loadPatch(sessionKey: sessionKey, path: path, quiet: false) }
    }

    private func loadPatch(sessionKey: String, path: String, quiet: Bool) async {
        if !quiet { patchLoading = true }
        let read = try? await client.changePatch(sessionKey: sessionKey, path: path)
        guard selectedPath == path else { return }
        patchLoading = false
        if let read, read != patch { patch = read }
    }
}

extension AppModel {
    /// One store per chat, so the header and the inspector share a single read.
    func changesStore(for sessionKey: String) -> ChangesStore {
        if let existing = changesStores[sessionKey] { return existing }
        let store = ChangesStore(client: client, demo: demoMode || captureMode)
        changesStores[sessionKey] = store
        return store
    }
}
