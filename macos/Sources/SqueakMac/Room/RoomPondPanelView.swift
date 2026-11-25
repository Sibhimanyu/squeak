import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, New layout: the Room's right side. Who is here, the Ducks working, Tasks waiting or
// blocked, and the way to the Notebook. Every list is the host's (`RoomPondPanel` groups it); a click only navigates.

struct RoomPondPanelView: View {
    let key: String
    let projectId: String
    let width: CGFloat
    @Environment(AppModel.self) private var model

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId) }
    private var roster: RoomRosterModel { RoomRosterStore.shared.model(for: projectId) }
    private var ponds: PondsModel { .shared }

    var body: some View {
        let threads = room.feed.threads
        let ducks = roster.ducks ?? threads.map(PondDuck.init(thread:))
        let panel = RoomPondPanel.build(
            members: ponds.detail(key: key)?.members ?? [], youName: NSFullUserName(),
            roster: RoomRoster.roster(ducks, threads: threads), tasks: room.feed.jobs)
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Space.xl) {
                    PondPeopleSection(panel: panel)
                    working(panel)
                    PondTasksSection(panel: panel)
                    PondNotebookRow(key: key)
                }
                .padding(.horizontal, 14).padding(.vertical, Space.l)
            }
        }
        .frame(width: width).frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.surface)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .accessibilityElement(children: .contain).accessibilityLabel("Pond panel")
        .task(id: threads) {
            try? await Task.sleep(for: .milliseconds(250))
            if !Task.isCancelled { await roster.refresh(host: model.nativeHost) }
        }
    }

    @ViewBuilder private func working(_ panel: RoomPondPanel) -> some View {
        PondPanelSection(title: "Ducks working", count: panel.working.count) {
            if panel.working.isEmpty {
                Text("No Duck is working right now.").font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            ForEach(panel.working) { d in
                Button {
                    if let s = d.sessionId { model.openFromPond(.duck(s), pond: key, page: .room) }
                } label: {
                    HStack(spacing: 8) {
                        DuckAvatar(sessionId: d.colourSeed, agent: d.agent, size: 26, off: false)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: d.name).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: d.presenceLine).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        WorkingGlyph(slot: 24, alignment: .trailing, grid: .compact)
                    }
                    .padding(.vertical, 3).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(d.name), \(d.presenceLine)")
            }
        }
    }
}
