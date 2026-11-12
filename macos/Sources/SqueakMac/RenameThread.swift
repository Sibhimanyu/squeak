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
        }
    }
}

extension AppModel {
    /// Asks for a name (Return saves, Esc cancels, an empty or over-long one is refused with its reason and asked again),
    /// then has the host store it. The list picks the new name up on the next refresh, which is asked for now.
    func renameThread(_ s: HostSession) {
        guard ThreadTitle.canRename(s), !demoMode, let c = nativeControls(for: s) else { return }
        var message = "Give this thread a name. It replaces the automatic one."
        var initial = workbenchTitle(s)
        while let typed = TextPrompt.ask(title: "Rename thread", message: message, placeholder: "Thread name", initial: initial, confirm: "Rename", allowEmpty: true) {
            switch ThreadTitle.check(typed) {
            case .failure(let problem):
                message = problem.words
                initial = typed
                continue
            case .success(let title):
                guard title != workbenchTitle(s) else { return }
                Task { [weak self] in
                    let result = await c.rename(s, to: title)
                    switch result {
                    case .done: await self?.broker.refresh()
                    case .refused(let reason), .failed(let reason): self?.native.note = reason
                    }
                }
                return
            }
        }
    }
}
