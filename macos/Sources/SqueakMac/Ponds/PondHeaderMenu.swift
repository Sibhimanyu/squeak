import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond header's ⋯ menu (Dashboard and Room). "Pond settings…" opens Settings on Ponds › this pond.

struct PondHeaderMenu: View {
    let key: String
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            Button("Pond settings\u{2026}") { model.openSettings(.pond(key)) }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("More for this pond").accessibilityLabel("More for this pond")
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
