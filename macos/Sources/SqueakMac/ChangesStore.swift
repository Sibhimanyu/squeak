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
    /// Review comments on the diff's lines, collected until "Send to chat" (DiffComments.swift in the core).
    private(set) var tray = DiffCommentTray()
    /// The lines a click on the gutter selected, while the comment box is open under them.
    struct CommentDraft: Equatable {
        var path: String
        var anchor: Int
        var head: Int
        var range: ClosedRange<Int> { DiffComments.range(anchor: anchor, to: head) }
    }
    private(set) var draft: CommentDraft?
    var draftText = ""
    var sending = false
    var sendNote: String?
    /// A Squeak chat's open comments from the host (the one list agents read through `list_review_notes`); empty for
    /// any other chat, which keeps its comments in the tray alone.
    private(set) var hostComments: [NativeComment] = []
    /// Tray comments already written to the host, so the diff draws them once (as the host's).
    private(set) var postedToHost: Set<UUID> = []
    @ObservationIgnored private var filePatches: [String: DaemonChangePatch] = [:]
    @ObservationIgnored private var patchStamps: [String: String] = [:]
    @ObservationIgnored private var lastRead: Date?
    @ObservationIgnored private var reading = false
    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool
    @ObservationIgnored private let host: NativeHostClient?
    /// The host's id for this chat; nil unless it is a Squeak chat.
    @ObservationIgnored private let hostId: String?

    init(client: DaemonClient, demo: Bool, host: NativeHostClient? = nil, hostId: String? = nil) {
        self.client = client; self.demo = demo; self.host = host; self.hostId = hostId
    }

    var isNative: Bool { host != nil && hostId != nil }

    func refreshComments() async {
        guard !demo, let host, let hostId, let read = try? await host.comments(id: hostId) else { return }
        if read != hostComments { hostComments = read }
    }

    func resolveHostComment(_ id: String) {
        guard let host, let hostId else { return }
        hostComments.removeAll { $0.id == id }
        Task { try? await host.resolveComment(id: hostId, commentId: id); await refreshComments() }
    }

    /// Reads the list when the policy says so (`force` for an activity change); the open file's diff follows it.
    func refresh(sessionKey: String, visible: Bool, activityChanged: Bool = false) async {
        if isNative { Task { await refreshComments() } }
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

    /// One file's whole diff for a diff tab, kept until the file's counts or status change. The tab reads it lazily,
    /// so a stack of fifty files costs a read per section that scrolls into view, not fifty at once.
    func patch(for path: String, sessionKey: String) async -> DaemonChangePatch? {
        let stamp = changes?.files.first { $0.path == path }.map { "\($0.status)/\($0.added)/\($0.removed)" } ?? ""
        if let cached = filePatches[path], patchStamps[path] == stamp { return cached }
        guard let read = try? await client.changePatch(sessionKey: sessionKey, path: path) else { return filePatches[path] }
        filePatches[path] = read; patchStamps[path] = stamp
        return read
    }

    func select(_ path: String?, sessionKey: String) async {
        cancelDraft()
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

extension ChangesStore {
    /// A click on a line's gutter: starts a comment there; with shift (and a comment already open in this file) it
    /// extends the selection to this line.
    func gutterClick(path: String, index: Int, extend: Bool) {
        if extend, let d = draft, d.path == path {
            draft = CommentDraft(path: path, anchor: d.anchor, head: index)
        } else {
            draft = CommentDraft(path: path, anchor: index, head: index)
            draftText = ""
        }
    }

    func cancelDraft() { draft = nil; draftText = "" }

    /// Puts the open comment in the tray (`lines`: the file's diff lines the selection indexes).
    func commitDraft(lines: [DiffLine]) {
        guard let d = draft, d.range.lowerBound >= 0, d.range.upperBound < lines.count,
              let c = DiffComments.make(path: d.path, lines: Array(lines[d.range]), text: draftText)
        else { return }
        tray.add(c)
        if let host, let hostId, let line = DiffComments.hostLine(of: c) {
            postedToHost.insert(c.id)
            Task {
                do { try await host.addComment(id: hostId, file: c.path, line: line, body: c.text) }
                catch { postedToHost.remove(c.id) }
                await refreshComments()
            }
        }
        cancelDraft()
        sendNote = nil
    }

    func removeComment(_ id: UUID) { tray.remove(id) }
    func clearTray() { tray.clear(); postedToHost = []; sendNote = nil }
    /// Tray comments the diff draws itself: all of them, except a Squeak chat's that the host list already shows.
    func trayComments(in path: String) -> [DiffComment] { tray.comments(in: path).filter { !postedToHost.contains($0.id) } }
}

extension AppModel {
    /// One store per chat, so the header and the inspector share a single read.
    func changesStore(for sessionKey: String) -> ChangesStore {
        if let existing = changesStores[sessionKey] { return existing }
        let nativeId = sessionKey.hasPrefix(NativeAdapter.keyPrefix) ? String(sessionKey.dropFirst(NativeAdapter.keyPrefix.count)) : nil
        let store = ChangesStore(client: client, demo: demoMode || captureMode, host: nativeId == nil ? nil : nativeHost, hostId: nativeId)
        changesStores[sessionKey] = store
        return store
    }
}
