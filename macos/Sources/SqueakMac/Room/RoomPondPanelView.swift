import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, New layout: the Room's right side. The Pond's name, who is here, the Ducks working, Tasks waiting or
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
                    header
                    people(panel)
                    working(panel)
                    tasks(panel)
                    notebook
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

    private var header: some View {
        HStack(spacing: 10) {
            PondTile(name: ponds.name(key: key), pondId: ponds.pond(key: key)?.id, projectId: projectId, size: 36)
            Text(verbatim: ponds.name(key: key)).font(.system(size: 16, weight: .bold)).foregroundStyle(Theme.ink).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
        }
    }

    private func section<C: View>(_ title: String, count: Int? = nil, @ViewBuilder _ content: () -> C) -> some View {
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

    private func people(_ panel: RoomPondPanel) -> some View {
        section("Here now", count: panel.present.count) {
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

    @ViewBuilder private func working(_ panel: RoomPondPanel) -> some View {
        section("Ducks working", count: panel.working.count) {
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

    @ViewBuilder private func tasks(_ panel: RoomPondPanel) -> some View {
        section("Tasks", count: panel.tasksOpen) {
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

    private var notebook: some View {
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
