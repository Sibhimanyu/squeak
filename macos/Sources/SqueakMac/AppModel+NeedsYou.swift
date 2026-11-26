import SqueakMacCore
import SwiftUI

// DESIGN.md §3.3, "Needs you": one rule (`NeedsYou`, the host's `needs-you.ts`) names the chats that want the person, and a
// failure stops counting once it is seen or dismissed. This file is the two ways of seeing it: opening the chat (reported once)
// and "Dismiss" on the item.
extension AppModel {
    /// Tells the host the failure was seen, then refreshes what draws it. `userAction` is Dismiss; otherwise the chat was opened.
    func dismissFailure(_ s: HostSession, userAction: Bool = true) {
        guard !demoMode, !captureMode, let id = NativeAdapter.nativeId(s), s.state == .error, s.errorSeenAt == nil else { return }
        if !userAction, !failuresReported.insert(s.key.stringValue).inserted { return }
        Task { [weak self] in
            guard let self else { return }
            do { _ = try await nativeHost.dismissError(id: id) }
            catch { if !userAction { failuresReported.remove(s.key.stringValue) }; return }
            await broker.refresh()
            if let pond = PondsModel.shared.key(of: s), let project = PondsModel.shared.native(key: pond) {
                RoomRosterStore.shared.model(for: project.id).refreshSoon(host: nativeHost)
            }
        }
    }

    /// The pond's chats the one rule names, newest first: what its mark's tooltip says and where its click goes.
    func needsYouItems(_ chats: [HostSession]) -> [NeedsYouItem] {
        PondNeedsYou.items(chats.map { withHostBackground($0) }, title: { [self] in workbenchTitle($0) })
    }

    /// A pond's mark was clicked: the one chat that needs the person, or the Pond's Needs-you list.
    func openNeedsYou(pond key: String, items: [NeedsYouItem]) {
        switch PondNeedsYou.target(items) {
        case .nothing: break
        case .chat(let chat): openFromPond(chat, pond: key, page: RoomViewPref.shared.mode(for: key))
        case .list:
            PondScopeRequest.shared.ask(.needsYou, pond: key)
            WorkbenchNav.openProject(self, key: key)
        }
    }
}

/// "Show me the Needs-you list": set by a pond's mark, read once by that pond's Dashboard when it appears (or already is open).
@MainActor @Observable final class PondScopeRequest {
    static let shared = PondScopeRequest()
    private(set) var pending: [String: PondDashboardScope] = [:]
    func ask(_ scope: PondDashboardScope, pond: String) { pending[pond] = scope }
    func take(pond: String) -> PondDashboardScope? { pending.removeValue(forKey: pond) }
}

/// "Dismiss" on a failed chat's menu: the person has dealt with it, or does not want to follow up.
struct DismissFailureItem: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if NeedsYou.failureCounts(session) { Button("Dismiss failure") { model.dismissFailure(session) } }
    }
}
