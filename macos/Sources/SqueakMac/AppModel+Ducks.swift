import SqueakIcons
import SqueakMacCore
import SwiftUI

// Flag `ducksOwnBranch` (docs/ponds.md "Ducks own their branch"): the duck menu and the move. Pure rules are in
// SqueakMacCore/Policy/DuckMode.swift; nothing here runs with the flag off.
extension AppModel {
    /// The pond (directory key) a duck's chat sits in.
    func duckPondKey(_ s: HostSession) -> String? { PondsModel.shared.key(of: s) }

    /// The ducks and branches a duck can join (its own pond's, never itself).
    func duckJoinTargets(for s: HostSession) -> [DuckJoinTarget] {
        guard let key = duckPondKey(s) else { return [] }
        return DuckList.joinTargets(duckRows(pond: key, fromPage: true), excluding: s.key)
    }

    /// Whether the duck menu shows for this chat: ducks mode, a native chat of a duck, in a pond whose chrome has code.
    func showsDuckMenu(_ s: HostSession) -> Bool {
        guard ducksMode, s.source == .squeak, s.duckId != nil, let key = duckPondKey(s) else { return false }
        return PondsModel.shared.chrome(key: key).showsBranchAndPR
    }

    /// Branch off, Work with…, Move to main: the host starts a fresh chat for the same duck in the new place; its tab
    /// is the same Duck, so it is the same tab: the tab follows the Duck to its new chat, then the new chat opens.
    /// A message to a chat in Main went to a new chat on its own branch: adopt it, swap its tab in, open it if the old one was open.
    func openMovedChat(from old: SessionKey, to sid: String) async {
        let agent = session(old)?.agent ?? "claude"
        let key = SessionKey(provider: "\(agent)-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + sid)
        if let made = try? await nativeHost.session(id: sid) {
            let stand = NativeAdapter.started(made)
            rememberStarted(stand)
            await broker.adopt(stand, adapterId: nativeAdapter.id)
        }
        await broker.refresh()
        let wasOpen = location == .chat(old)
        if wasOpen { select(key) }
    }

    func moveDuck(_ s: HostSession, to place: DuckPlace) {
        guard let duckId = s.duckId, !demoMode else { return }
        let old = s.key
        let agent = s.agent ?? "claude"
        Task { [weak self] in
            guard let self else { return }
            do {
                let sid = try await nativeHost.placeDuck(id: duckId, place: place)
                let key = SessionKey(provider: "\(agent)-squeak", workspaceId: nil, hostSessionId: NativeAdapter.keyPrefix + sid)
                if let made = try? await nativeHost.session(id: sid) {
                    let stand = NativeAdapter.started(made)
                    rememberStarted(stand)
                    await broker.adopt(stand, adapterId: nativeAdapter.id)
                }
                await broker.refresh()
                let wasOpen = location == .chat(old)
                if wasOpen { select(key) }
                AppLog.info("duck moved")
            } catch let e as NativeHostError {
                HeresayBridge.trouble()
                native.note = e.reason
            } catch {
                HeresayBridge.trouble()
                native.note = "Squeak couldn\u{2019}t move that duck"
            }
        }
    }
}

/// "Work with…" rows: other ducks, then branches. Picks call `pick` with the place.
struct DuckWorkWithItems: View {
    let targets: [DuckJoinTarget]
    let pick: (DuckPlace) -> Void

    var body: some View {
        let ducks = targets.filter { if case .duck = $0.kind { true } else { false } }
        let branches = targets.filter { if case .branch = $0.kind { true } else { false } }
        ForEach(ducks) { t in
            Button { pick(t.place) } label: { Label("\(t.title) \u{00B7} \(t.branch)", systemImage: "bird") }
        }
        if !ducks.isEmpty, !branches.isEmpty { Divider() }
        ForEach(branches) { t in
            Button { pick(t.place) } label: { Label(t.branch, systemImage: "arrow.triangle.branch") }
        }
    }
}

/// The duck menu, shared by a tab's and a sidebar row's context menu.
struct DuckMenuItems: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.showsDuckMenu(session) {
            let onMain = model.duckRow(session).isMain
            Divider()
            Button("Branch off") { model.moveDuck(session, to: .new(branch: nil)) }
            let targets = model.duckJoinTargets(for: session)
            if !targets.isEmpty {
                SqueakMenu("Work with\u{2026}") { DuckWorkWithItems(targets: targets) { model.moveDuck(session, to: $0) } }
            }
            if !onMain { Button("Move to main") { model.moveDuck(session, to: .main) } }
        }
        if model.hasDuckLife(session) {
            Divider()
            // Closing a tab never opens or closes the duck: resting is a choice made here, not a side effect of closing.
            if model.isOpen(session) { Button("Close") { model.setOpen(session, open: false) } }
            else { Button(RoomRoster.bringBackTitle) { model.setOpen(session, open: true) } }
            Button("Delete Duck\u{2026}", role: .destructive) { model.confirmDeleteDuck(session) }
        }
    }
}

extension AppModel {
    /// The duck's project and host session id, for the room and the open and close routes (a native chat of a Duck in ducks mode).
    private func duckHostRef(_ s: HostSession) -> (project: String, id: String)? {
        guard ducksMode, s.source == .squeak, s.duckId != nil, let pond = duckPondKey(s),
              let project = PondsModel.shared.entry(pond)?.projectId else { return nil }
        return (project, s.key.hostSessionId)
    }

    /// The name the new composer's chip shows: the host's Duck name, the chat title only for a chat with no Duck.
    func composerDuckName(_ s: HostSession) -> String {
        let project = duckPondKey(s).flatMap { PondsModel.shared.entry($0)?.projectId }
        let ducks = project.flatMap { RoomRosterStore.shared.model(for: $0).ducks }
        return ComposerChip.duckName(duckId: s.duckId, sessionId: s.key.hostSessionId, ducks: ducks, chatTitle: s.title) ?? ""
    }

    /// Whether the duck menu offers Closed and Delete Duck for this chat.
    func hasDuckLife(_ s: HostSession) -> Bool { duckHostRef(s) != nil }

    func isOpen(_ s: HostSession) -> Bool {
        guard let r = duckHostRef(s) else { return true }
        return RoomRosterStore.shared.model(for: r.project).list.first { $0.currentSessionId == r.id }?.isOpen ?? true
    }

    func setOpen(_ s: HostSession, open: Bool) {
        guard let r = duckHostRef(s) else { return }
        Task {
            await PondRoomStore.shared.model(for: r.project).setOpen(sessionId: r.id, open: open, host: nativeHost)
            await RoomRosterStore.shared.model(for: r.project).refresh(host: nativeHost)
        }
    }

    /// "Delete Duck\u{2026}": asks once, then removes the duck for good and closes its tab.
    func confirmDeleteDuck(_ s: HostSession) {
        guard let r = duckHostRef(s), let duckId = s.duckId else { return }
        let name = RoomRosterStore.shared.model(for: r.project).list.first { $0.currentSessionId == r.id }?.name ?? workbenchTitle(s)
        let alert = NSAlert()
        alert.messageText = "Delete \(name)?"
        alert.informativeText = "This removes the duck for good. Its chats stay in history. To rest it instead, close it."
        alert.addButton(withTitle: "Delete Duck")
        alert.addButton(withTitle: "Cancel")
        alert.buttons.first?.hasDestructiveAction = true
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let pond = duckPondKey(s)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await nativeHost.deleteDuck(id: duckId)
                closeTabs(ofDuck: duckId)
                if lastChat == s.key { if let pond { WorkbenchNav.openProject(self, key: pond, resuming: false) } else { WorkbenchNav.goHome(self) } }
                await broker.refresh()
            } catch let e as NativeHostError {
                native.note = e.reason
            } catch {
                native.note = "Squeak couldn\u{2019}t delete that duck"
            }
        }
    }
}

/// A branch's PR state word for the pond page ("Open", "Merged"…), from the lead duck's git status when it is loaded.
@MainActor func duckBranchPRWord(_ lead: HostSession?, model: AppModel) -> String? {
    guard let lead, let pr = model.gitStatus(lead)?.pr else { return nil }
    return GitPresentation.prWord(pr)
}

/// The header's duck chip (ducks mode): the branch, or "main · read-only". Create PR stays in `GitCluster`.
struct DuckBranchChip: View {
    let chrome: DuckHeaderChrome
    var ghost = false

    var body: some View {
        if let chip = chrome.chip {
            HStack(spacing: 4) {
                if !chrome.readOnly { Lucide(.gitBranch, size: 11, color: Theme.muted) }
                Text(verbatim: chip).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 7).frame(height: 22)
            .overlay { if !ghost { RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong) } }
            .help(chrome.readOnly ? "Main is read-only for ducks: a duck that needs to edit branches off." : "This duck\u{2019}s branch")
            .accessibilityLabel(chrome.readOnly ? "On main, read only" : "Branch \(chip)")
        }
    }
}
