import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond header's ⋯ menu (Dashboard and Room). "Pond settings…" opens Settings on Ponds › this pond.

struct PondHeaderMenu: View {
    let key: String
    @Environment(AppModel.self) private var model
    @State private var leaving: String?
    @State private var confirmGitPond = false
    @State private var gitPondBusy = false
    @State private var gitPondOutcome: (title: String, message: String)?

    private var ponds: PondsModel { .shared }

    var body: some View {
        let pond = ponds.pond(key: key)
        let native = ponds.native(key: key)
        let role = ponds.detail(key: key)?.myRole ?? pond?.role ?? .owner
        let offer = FirstPondJourney.menuOffer(
            canInvite: role.canInvite, hasPond: pond != nil, plainFolder: native?.isPlainFolder == true, isRemote: ponds.chrome(key: key).isRemote)
        Menu {
            // The next steps of a first pond, findable from the pond itself.
            if offer.invite, let pond {
                Button(FirstPondJourney.inviteItem) { ponds.startInvite(pondId: pond.id, account: model.account) }
                    .disabled(!ponds.freshness(pond).canWrite)
            }
            if offer.gitPond {
                Button(FirstPondJourney.gitPondItem) {
                    if model.demoMode { gitPondOutcome = (FirstPondJourney.gitPondFailedTitle, "Demo data: nothing is changed.") } else { confirmGitPond = true }
                }
                .disabled(gitPondBusy).help(FirstPondJourney.gitPondHelp)
            }
            if offer.invite || offer.gitPond { Divider() }
            Button("Pond settings\u{2026}") { model.openSettings(.pond(key)) }
            // A pond someone else owns can be left; the person's own pond never shows it.
            if PondsModel.shared.chrome(key: key).showsLeave { Button("Leave pond\u{2026}") { leaving = key } }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("More for this pond").accessibilityLabel("More for this pond")
        .leavePondDialog($leaving)
        .confirmationDialog("Make \(ponds.name(key: key)) a Git Pond?", isPresented: $confirmGitPond, titleVisibility: .visible) {
            if let native = ponds.native(key: key) {
                Button("Private repository on GitHub") { makeGitPond(native, isPublic: false) }
                Button("Public repository on GitHub") { makeGitPond(native, isPublic: true) }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(verbatim: FolderPond.gitPondQuestion(isPublic: false) + " Choose public only if you want everyone to see it.")
        }
        .alert(gitPondOutcome?.title ?? "", isPresented: Binding(get: { gitPondOutcome != nil }, set: { if !$0 { gitPondOutcome = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(verbatim: gitPondOutcome?.message ?? "")
        }
    }

    private func makeGitPond(_ p: NativeProject, isPublic: Bool) {
        gitPondBusy = true
        Task {
            defer { gitPondBusy = false }
            do {
                let url = try await model.nativeHost.makeGitPond(projectId: p.id, isPublic: isPublic)
                gitPondOutcome = (FirstPondJourney.gitPondDoneTitle, FolderPond.gitPondResult(url: url))
                await model.refreshNativeProjects()
            } catch let e as NativeHostError {
                gitPondOutcome = (FirstPondJourney.gitPondFailedTitle, e.reason)
            } catch {
                gitPondOutcome = (FirstPondJourney.gitPondFailedTitle, "Squeak couldn\u{2019}t make this pond a Git Pond.")
            }
        }
    }
}

extension View {
    /// "Leave pond…": a one-line confirmation, then the daemon's leave; on success the pond leaves the sidebar and the
    /// Dashboard opens (`PondsModel.leaveAndDrop`).
    func leavePondDialog(_ key: Binding<String?>) -> some View { modifier(LeavePondDialog(key: key)) }
}

private struct LeavePondDialog: ViewModifier {
    @Binding var key: String?

    func body(content: Content) -> some View {
        let name = key.map { PondsModel.shared.name(key: $0) } ?? ""
        content.confirmationDialog("Leave \(name)?", isPresented: Binding(get: { key != nil }, set: { if !$0 { key = nil } }), titleVisibility: .visible) {
            Button("Leave", role: .destructive) {
                guard let k = key else { return }
                key = nil
                Task { _ = await PondsModel.shared.leaveAndDrop(key: k) }
            }
            Button("Cancel", role: .cancel) { key = nil }
        } message: {
            Text(verbatim: PondActionWords.leaveMessage(name))
        }
    }
}

/// Settings › Ponds: the ponds newest activity first, and the selected pond's settings page (look, streams, people,
/// invites, agents, this Mac).
struct PondsSettings: View {
    @Environment(AppModel.self) private var model
    private var ponds: PondsModel { .shared }

    var body: some View {
        let list = SettingsPonds.ordered(ponds.directory?.ponds ?? [])
        let selected = SettingsPonds.selection(requested: model.settingsPond, in: list)
        VStack(alignment: .leading, spacing: Space.l) {
            if list.isEmpty {
                Text("No ponds yet. Add a project and it shows up here.").font(Typo.body).foregroundStyle(Theme.muted).padding(.horizontal, 24)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(list) { p in
                            Button { model.settingsPond = p.id } label: {
                                HStack(spacing: 8) {
                                    PondTile(name: p.name, pondId: p.pondId, projectId: p.projectId, size: 22)
                                    Text(verbatim: p.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                                }
                                .padding(.horizontal, 10).frame(height: 34)
                                .background(p.id == selected ? Theme.selectedStrong : Theme.selected, in: Capsule())
                                .contentShape(Capsule())
                            }
                            .buttonStyle(.plain).accessibilityAddTraits(p.id == selected ? .isSelected : [])
                        }
                    }
                    .padding(.horizontal, 24)
                }
                if let selected { PondSettingsView(key: selected, embedded: true).id(selected) }
            }
        }
    }
}
