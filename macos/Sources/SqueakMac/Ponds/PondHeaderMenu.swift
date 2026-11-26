import SqueakIcons
import SqueakMacCore
import SwiftUI

// The Pond's ⋯ menu: on the Dashboard it sits in the page header and holds what the three buttons do not (Pond settings,
// Notebook, Rename, Leave or Delete); in the Room's bar the same menu also keeps Invite and Put on GitHub. What it holds
// for a role is decided in `PondDashboardHeader.menu` (SqueakMacCore).

struct PondHeaderMenu: View {
    let key: String
    /// The Room's bar keeps Invite and Put on GitHub here (the Dashboard has them as buttons).
    var withActions = false
    @Environment(AppModel.self) private var model
    @State private var leaving: String?
    @State private var confirmGitPond = false
    @State private var gitPondBusy = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var deleting = false

    private var ponds: PondsModel { .shared }

    var body: some View {
        let pond = ponds.pond(key: key)
        let plan = ponds.dashboardHeader(key: key)
        let name = ponds.name(key: key)
        Menu {
            if withActions {
                if plan.showsInvite, let pond {
                    Button(FirstPondJourney.inviteItem) { ponds.startInvite(pondId: pond.id, account: model.account) }
                        .disabled(!ponds.freshness(pond).canWrite)
                }
                if plan.showsPutOnGitHub {
                    Button(FirstPondJourney.putOnGitHubItem) { confirmGitPond = true }
                        .disabled(gitPondBusy).help(FirstPondJourney.gitPondHelp)
                }
                if plan.showsInvite || plan.showsPutOnGitHub { Divider() }
            }
            ForEach(plan.menu, id: \.self) { item in
                switch item {
                case .settings: Button("Pond settings\u{2026}") { model.openSettings(.pond(key)) }
                case .notebook: Button("Notebook") { model.openPondItem(.notebook) }
                case .rename: Button("Rename\u{2026}") { newName = name; renaming = true }.disabled(!ponds.freshness(pond).canWrite)
                case .leave: Button("Leave \(name)\u{2026}") { leaving = key }
                case .delete: Button("Delete \(name)\u{2026}", role: .destructive) { deleting = true }.disabled(!ponds.freshness(pond).canWrite)
                }
            }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("More for this Pond").accessibilityLabel("More for this Pond")
        .leavePondDialog($leaving)
        .gitPondFlow(key: key, ask: $confirmGitPond, busy: $gitPondBusy)
        .alert("Rename \(name)", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Rename") {
                let n = newName.trimmingCharacters(in: .whitespaces)
                if let pond, !n.isEmpty, n != name { Task { _ = await ponds.rename(pond: pond.id, name: n) } }
            }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete \(name) for everyone?", isPresented: $deleting, titleVisibility: .visible) {
            Button("Delete for everyone", role: .destructive) { if let pond { Task { _ = await ponds.deletePond(pond: pond.id) } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(verbatim: PondActionWords.deleteMessage(name, others: max(0, (ponds.detail(key: key)?.members.count ?? pond?.memberCount ?? 1) - 1)))
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
            Text(verbatim: PondActionWords.leaveMessage(name, owner: key.flatMap { PondsModel.shared.pond(key: $0)?.ownerName }))
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
