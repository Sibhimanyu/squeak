import SqueakIcons
import SqueakMacCore
import SwiftUI

// The Pond's ⋯ menu: on the Dashboard it sits in the page header and holds what the three buttons do not (Pond settings,
// Notebook, Rename, Delete Pond or Leave Pond, in the words the daemon's PondEnding offers); in the Room's bar the same menu also keeps Invite and Put on GitHub. What it holds
// for a role is decided in `PondDashboardHeader.menu` (SqueakMacCore).

struct PondHeaderMenu: View {
    let key: String
    /// The Room's bar keeps Invite and Put on GitHub here (the Dashboard has them as buttons).
    var withActions = false
    @Environment(AppModel.self) private var model
    @State private var ending: String?
    @State private var confirmGitPond = false
    @State private var gitPondBusy = false
    @State private var renaming = false
    @State private var newName = ""

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
                case .leave, .delete:
                    // One item for both: the daemon says which it is (Delete Pond… or Leave Pond…) and in what words.
                    if let pond { Button(pond.endOffering.words.menu, role: .destructive) { ending = key }.disabled(!ponds.freshness(pond).canWrite && !pond.local) }
                }
            }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("More for this Pond").accessibilityLabel("More for this Pond")
        .endPondDialog($ending)
        .gitPondFlow(key: key, ask: $confirmGitPond, busy: $gitPondBusy)
        .alert("Rename \(name)", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Rename") {
                let n = newName.trimmingCharacters(in: .whitespaces)
                if let pond, !n.isEmpty, n != name { Task { _ = await ponds.rename(pond: pond.id, name: n) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }
}

extension View {
    /// "Delete Pond…" / "Leave Pond…": one confirmation drawing the words the daemon's PondEnding offers for that Pond, then
    /// its end; on success the pond leaves the sidebar (`PondsModel.endAndDrop`). A failure stays on the Pond with Try again.
    func endPondDialog(_ key: Binding<String?>) -> some View { modifier(EndPondDialog(key: key)) }
}

private struct EndPondDialog: ViewModifier {
    @Binding var key: String?

    func body(content: Content) -> some View {
        let offer = key.flatMap { PondsModel.shared.pond(key: $0)?.endOffering }
        content.confirmationDialog(offer?.words.title ?? "", isPresented: Binding(get: { key != nil }, set: { if !$0 { key = nil } }), titleVisibility: .visible) {
            if let offer, offer.blockedBy == nil {
                Button(offer.words.button, role: .destructive) {
                    guard let k = key else { return }
                    key = nil
                    Task { _ = await PondsModel.shared.endAndDrop(key: k) }
                }
            }
            Button("Cancel", role: .cancel) { key = nil }
        } message: {
            Text(verbatim: offer?.blockedBy ?? offer?.words.message ?? "")
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
