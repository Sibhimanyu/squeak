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
    /// replaces the old one in the same slot, then it opens (no close and open, so the strip does not flicker).
    func moveDuck(_ s: HostSession, to place: DuckPlace) {
        guard let duckId = s.duckId, !demoMode else { return }
        let old = s.key
        let workspace = (sidebarTree.place(of: old) ?? pondPageTree.place(of: old))?.workspace.id
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
                if let workspace { replaceStreamTab(.thread(old.stringValue), with: .thread(key.stringValue), in: workspace) }
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

    var body: some View {
        if let chip = chrome.chip {
            HStack(spacing: 4) {
                if !chrome.readOnly { Lucide(.gitBranch, size: 11, color: Theme.muted) }
                Text(verbatim: chip).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
            }
            .padding(.horizontal, 7).frame(height: 22)
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            .help(chrome.readOnly ? "Main is read-only for ducks: a duck that needs to edit branches off." : "This duck\u{2019}s branch")
            .accessibilityLabel(chrome.readOnly ? "On main, read only" : "Branch \(chip)")
        }
    }
}
