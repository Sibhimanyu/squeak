import AppKit
import SqueakMacCore
import SwiftUI

/// "Rename…" (Squeak's own chats only: the host owns their names) and Archive / Unarchive (every kind of thread) in a
/// thread's context menu, wherever threads are listed.
struct RenameThreadItem: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if ThreadTitle.canRename(session) { Button("Rename…") { model.renameThread(session) } }
        // Archive and Unarchive sit with Rename for every kind of thread (ThreadArchive.menuItem decides).
        switch ThreadArchive.menuItem(session) {
        case .archive: Button("Archive") { model.archiveThread(session, archived: true) }
        case .unarchive: Button("Unarchive") { model.archiveThread(session, archived: false) }
        case nil: EmptyView()
        }
    }
}

extension AppModel {
    /// Archives or unarchives an add-on thread (a Squeak chat is a Duck and has no archive; Off duty is its only rest). The
    /// thread is hidden in Squeak only, by the daemon. A refusal shows as the note;
    /// the lists follow the next refresh, which is asked for now.
    func archiveThread(_ s: HostSession, archived: Bool) {
        guard !demoMode, let kind = ThreadArchive.kind(s) else { return }
        Task { [weak self] in
            guard let self else { return }
            let result: NativeActionResult
            switch kind {
            case .squeak:
                return  // Ducks have no archive (Off duty and Delete Duck)
            case .fleet:
                result = await self.client.archiveThread(sessionKey: s.key.hostSessionId, archived: archived)
            }
            switch result {
            case .done: await self.broker.refresh()
            case .refused(let reason), .failed(let reason): self.native.note = reason
            }
        }
    }

    /// ⇧⌘A and the Chat menu: archive the open thread, or show it again when it is archived.
    func archiveSelectedThread() {
        guard let s = selectedSession, let item = ThreadArchive.menuItem(s) else { return }
        archiveThread(s, archived: item == .archive)
    }

    /// The Chat menu's item: its words follow the open thread; nil when it cannot be archived now.
    var archiveMenuTitle: String? {
        guard let s = selectedSession, let item = ThreadArchive.menuItem(s) else { return nil }
        return item == .archive ? "Archive Duck" : "Unarchive Duck"
    }

    var renamingThread: SessionKey? { inlineRename.editing }
    var renameProblem: String? { inlineRename.problem }
    func isRenaming(_ s: HostSession) -> Bool { inlineRename.isEditing(s.key) }
    func renameEdited() { inlineRename.edited() }
    func cancelRename() { inlineRename.cancel() }

    /// "Rename…" and a double-click: the title turns into a field where it is shown. Demo mode refuses, as before.
    func renameThread(_ s: HostSession) {
        guard ThreadTitle.canRename(s), !demoMode, nativeControls(for: s) != nil else { return }
        inlineRename.start(s.key, canRename: true)
    }

    /// Return in the field: a refused name keeps the field open with its reason; a new one shows at once and is stored by
    /// the host (on a refusal the old title returns and the reason is the note); the list follows the next refresh.
    func commitRename(_ s: HostSession, typed: String) {
        guard let c = nativeControls(for: s) else { inlineRename.cancel(); return }
        switch inlineRename.commit(typed, current: workbenchTitle(s)) {
        case .invalid, .unchanged: return
        case .save(let title):
            renameOverride[s.key] = title
            Task { [weak self] in
                let result = await c.rename(s, to: title)
                switch result {
                case .done: await self?.broker.refresh()
                case .refused(let reason), .failed(let reason): self?.native.note = reason
                }
                self?.renameOverride[s.key] = nil
            }
        }
    }
}
