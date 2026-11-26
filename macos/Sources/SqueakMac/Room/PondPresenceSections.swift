import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the pieces of "who and what is going on in this Pond", shared by the Room's side panel and the Dashboard
// (which has no side panel of its own). Every list is the host's, grouped by `RoomPondPanel`; a click only navigates.

/// A titled group with a quiet count at its right.
struct PondPanelSection<C: View>: View {
    let title: String
    var count: Int?
    @ViewBuilder let content: () -> C

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(verbatim: title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.subtle)
                Spacer(minLength: 0)
                if let count { Text("\(count)").font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle) }
            }
            .accessibilityAddTraits(.isHeader)
            content()
        }
    }
}

/// The Pond's `RoomPondPanel` for the current host state: people from the directory, Ducks from the roster, Tasks from the Room.
@MainActor
enum PondPresence {
    static func panel(key: String, projectId: String) -> RoomPondPanel {
        let room = PondRoomStore.shared.model(for: projectId)
        let threads = room.feed.threads
        let ducks = RoomRosterStore.shared.model(for: projectId).list
        return RoomPondPanel.build(
            members: PondsModel.shared.detail(key: key)?.members ?? [], youName: PondsModel.shared.myName,
            roster: RoomRoster.roster(ducks, threads: threads), tasks: room.feed.jobs)
    }
}

struct PondPeopleSection: View {
    let panel: RoomPondPanel

    var body: some View {
        PondPanelSection(title: "Here now", count: panel.present.count) {
            ForEach(panel.present) { p in
                HStack(spacing: 8) {
                    PersonAvatar(name: p.name, size: 26)
                    Text(verbatim: p.you ? "\(p.name) (you)" : p.name).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 3)
                .accessibilityElement(children: .combine)
            }
        }
    }
}

struct PondTasksSection: View {
    let panel: RoomPondPanel

    var body: some View {
        PondPanelSection(title: "Tasks", count: panel.tasksOpen) {
            if panel.tasksOpen == 0 {
                Text("Nothing is waiting.").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            ForEach(panel.blocked) { taskRow($0) }
            ForEach(panel.waiting) { taskRow($0) }
        }
    }

    private func taskRow(_ t: RoomTask) -> some View {
        HStack(alignment: .top, spacing: 8) {
            // Blocked is the one Task state that needs the person: the amber triangle, nothing else coloured.
            if t.state == .blocked { Lucide(.triangleAlert, size: 12, color: Theme.warning).padding(.top, 2) }
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: t.title).font(.system(size: 12.5)).foregroundStyle(Theme.ink).lineLimit(2)
                Text(verbatim: t.state.label).font(.system(size: 11)).foregroundStyle(Theme.subtle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 9).padding(.vertical, 7)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

struct PondNotebookRow: View {
    let key: String
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.openPond(.settings(project: key)) } label: {
            HStack(spacing: 10) {
                Lucide(.clipboardList, size: 16, color: Theme.muted)
                VStack(alignment: .leading, spacing: 0) {
                    Text("Notebook").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                    Text("What the Ducks have learned here").font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
                Spacer(minLength: 0)
                Lucide(.chevronRight, size: 12, color: Theme.subtle)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Notebook").accessibilityHint("Opens the Pond's settings, where the Notebook is")
    }
}
