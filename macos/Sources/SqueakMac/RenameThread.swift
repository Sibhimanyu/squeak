import AppKit
import SqueakMacCore
import SwiftUI

/// "Rename…" in a thread's context menu, wherever threads are listed. Offered only for Squeak's own chats (the host
/// owns their names); a Conductor or terminal thread shows no item at all.
struct RenameThreadItem: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if ThreadTitle.canRename(session) {
            Button("Rename…") { model.renameThread(session) }
            // Archive and Unarchive sit with Rename: the same chats (Squeak's own), and only where the host will do it.
            if ThreadArchive.canArchive(session) { Button("Archive") { model.archiveThread(session, archived: true) } }
            if ThreadArchive.canUnarchive(session) { Button("Unarchive") { model.archiveThread(session, archived: false) } }
        }
    }
}

extension AppModel {
    /// Has the host archive or unarchive the chat. The host refuses a working or waiting chat in its own sentence, shown
    /// as the note; the lists follow the next refresh, which is asked for now.
    func archiveThread(_ s: HostSession, archived: Bool) {
        guard ThreadTitle.canRename(s), !demoMode, let c = nativeControls(for: s) else { return }
        Task { [weak self] in
            let result = await c.archive(s, archived: archived)
            switch result {
            case .done: await self?.broker.refresh()
            case .refused(let reason), .failed(let reason): self?.native.note = reason
            }
        }
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
