import Foundation
import SqueakMacCore

extension AppModel {
    /// Opens a canvas as a tab of its pond's chat strip (a canvas is an artifact of kind canvas).
    func openCanvas(pond: String, path: String, pin: Bool = false) { openArtifact(pond: pond, path: path, pin: pin) }

    /// "Ask a duck…": takes the person to the pond's current chat with `prefill` at the start of its composer, in front of
    /// any draft already there. A pond with no chat starts a new duck instead (the New duck page, message prefilled).
    func askDuck(pond: String, prefill: String) {
        guard let ctx = artifactContext(pond: pond) else {
            if let id = PondsModel.shared.native(key: pond)?.id { NewChatController.shared.open(.thread(projectId: id, workspaceId: nil), text: prefill) }
            return
        }
        let key = ctx.key
        Task { [weak self] in
            guard let self else { return }
            // Saved first: the chat loads its draft from the store when it opens, so the prefill is there from the start.
            let saved = await broker.draft(for: key) ?? ""
            let text = saved.hasPrefix(prefill) ? saved : prefill + saved
            await broker.setDraft(text, for: key)
            select(key)
            if lastChat == key { setDraft(text) }
        }
    }
}
