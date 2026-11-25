import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, New layout: the centre top of a Pond is a row of round Duck avatars instead of tabs. What is in it,
// in what order and what is selected comes from `DuckAvatarRow` (SqueakMacCore); this file only draws it and sends the
// two clicks (Room, a Duck) to the same navigation the rest of the app uses. It changes no Duck's duty.

/// The row for one Pond. Draws nothing for a Pond this Mac has no host project for (a Member's remote Pond keeps the old
/// strip): ask `isAvailable` before replacing the strip.
struct DuckAvatarRowView: View {
    let key: String
    let place: DuckRowPlace
    /// Room for the sidebar toggle while the sidebar is closed.
    var leadingInset: CGFloat = 0

    static func isAvailable(pond key: String) -> Bool { PondsModel.shared.native(key: key) != nil }

    var body: some View {
        if let project = PondsModel.shared.native(key: key) {
            DuckAvatarRowContent(key: key, projectId: project.id, place: place, leadingInset: leadingInset)
        }
    }
}

enum DuckRowMetrics {
    static let height: CGFloat = 56
    static let avatar: CGFloat = 34
}

private struct DuckAvatarRowContent: View {
    let key: String
    let projectId: String
    let place: DuckRowPlace
    let leadingInset: CGFloat
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var room: PondRoomModel { PondRoomStore.shared.model(for: projectId) }
    private var roster: RoomRosterModel { RoomRosterStore.shared.model(for: projectId) }

    var body: some View {
        let threads = room.feed.threads
        let ducks = roster.ducks ?? threads.map(PondDuck.init(thread:))
        let row = DuckAvatarRow.build(roster: RoomRoster.roster(ducks, threads: threads), place: place)
        HStack(spacing: 0) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    RoomChip(key: key, selected: row.roomSelected, action: openRoom)
                    Rectangle().fill(Theme.line).frame(width: 1, height: 26).padding(.horizontal, 4)
                    ForEach(row.ducks) { d in
                        DuckChip(duck: d, selected: row.selectedDuck == d.id) { open(d) }
                    }
                }
                .padding(.horizontal, 2)
            }
        }
        .padding(.horizontal, Space.l)
        .frame(height: DuckRowMetrics.height).frame(maxWidth: .infinity)
        .background(WindowDragArea())
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .animation(reduceMotion ? nil : Motion.quick, value: row.selection)
        .accessibilityElement(children: .contain).accessibilityLabel("Ducks")
        // The roster is the host's list: refreshed when the Room's threads change and slowly while a Duck's chat is open
        // (the Room is not running then).
        .task(id: threads) {
            try? await Task.sleep(for: .milliseconds(250))
            if !Task.isCancelled { await roster.refresh(host: model.nativeHost) }
        }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                if !Task.isCancelled { await roster.refresh(host: model.nativeHost) }
            }
        }
    }

    private func openRoom() {
        RoomViewPref.shared.set(.room, for: key)
        model.openPondHome(key)
    }

    /// The Duck's chat in the centre. Duty is not touched: an Off duty Duck stays Off duty while it is open.
    private func open(_ d: DuckRowAvatar) {
        guard let sessionId = d.sessionId else { return }
        model.openFromPond(.duck(sessionId), pond: key, page: RoomViewPref.shared.mode(for: key))
    }
}

/// The Room's avatar: the Pond's own colour with a chat mark.
private struct RoomChip: View {
    let key: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        let pond = PondsModel.shared.pond(key: key)
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(PondColour.tint(pond?.id)).frame(width: DuckRowMetrics.avatar, height: DuckRowMetrics.avatar)
                    .overlay { Lucide(.messageSquare, size: 16, color: Theme.ink) }
                Text("Room").font(.system(size: 13, weight: .medium)).foregroundStyle(selected ? Theme.ink : Theme.muted)
            }
            .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 5)
            .background(selected ? Theme.selected : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Theme.lineStrong : .clear))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Room").accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// One Duck: its tinted thread duck on a soft round tile, the name and a quiet status line beside it. The working glyph
/// only while it works, the amber triangle only while it waits on the person; an Off duty Duck is dimmed.
private struct DuckChip: View {
    let duck: DuckRowAvatar
    let selected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                avatar
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: duck.name).font(.system(size: 13, weight: .medium)).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1)
                    Text(verbatim: duck.presenceLine).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                .frame(maxWidth: 110, alignment: .leading)
            }
            .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 5)
            .background(selected ? Theme.selected : .clear, in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? Theme.lineStrong : .clear))
            .opacity(duck.onDuty ? 1 : 0.6)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(duck.opensChat ? "\(duck.name) \u{00B7} \(duck.presenceLine)" : "\(duck.name) has no chat yet")
        .accessibilityLabel("\(duck.name), \(duck.presenceLine)")
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }

    private var avatar: some View {
        let c = ThreadDuck.rgb(for: duck.colourSeed, dark: scheme == .dark)
        let colour = Color(red: c.r, green: c.g, blue: c.b)
        return Circle().fill(Theme.surfaceRaised)
            .overlay(Circle().fill(colour.opacity(0.18)))
            .frame(width: DuckRowMetrics.avatar, height: DuckRowMetrics.avatar)
            .overlay { ThreadDuckView(id: duck.colourSeed, size: 22) }
            .overlay(alignment: .bottomTrailing) {
                if duck.showsWorkingGlyph {
                    WorkingGlyph(slot: 12, alignment: .center, grid: .micro).scaleEffect(0.8).frame(width: 15, height: 15)
                        .background(Theme.bg, in: Circle()).offset(x: 3, y: 3)
                }
            }
            .overlay(alignment: .topTrailing) {
                if duck.needsYou {
                    Lucide(.triangleAlert, size: 10, color: Theme.warning).frame(width: 15, height: 15)
                        .background(Theme.bg, in: Circle()).offset(x: 3, y: -3)
                }
            }
            .accessibilityHidden(true)
    }
}
