import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, New layout: the centre top of a Pond is a row of round Duck avatars instead of tabs. What is in it,
// in what order and what is selected comes from `DuckAvatarRow` (SqueakMacCore); this file only draws it and sends the
// two clicks (Room, a Duck) to the same navigation the rest of the app uses. It opens or closes no Duck.

/// The row for one Pond. Draws nothing for a Pond this Mac has no host project for (a Member's remote Pond keeps the old
/// strip): ask `isAvailable` before replacing the strip.
struct DuckAvatarRowView: View {
    let key: String
    let place: DuckRowPlace
    /// Room for the sidebar toggle while the sidebar is closed.
    var leadingInset: CGFloat = 0

    static func isAvailable(pond key: String) -> Bool { PondsModel.shared.native(key: key) != nil }

    /// Whether the row draws anything now: false while nobody is open (the page's header then carries the sidebar clearance).
    static func isShown(pond key: String, place: DuckRowPlace) -> Bool {
        guard let project = PondsModel.shared.native(key: key) else { return false }
        let threads = PondRoomStore.shared.model(for: project.id).feed.threads
        let ducks = RoomRosterStore.shared.model(for: project.id).list
        return !DuckAvatarRow.build(roster: RoomRoster.roster(ducks, threads: threads), place: place).isEmpty
    }

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
        let ducks = roster.list
        let row = DuckAvatarRow.build(roster: RoomRoster.roster(ducks, threads: threads), place: place)
        // Nothing open and no Duck open: no strip at all (the pond header's Dashboard | Room switch is the way to the Room).
        // The sidebar's toggle then sits in the pond header, which carries the clearance itself.
        VStack(spacing: 0) { if !row.isEmpty { strip(row) } }
        // The roster is the host's list, read through its one shared model (one poll; the Room's changes ask for an early read).
        .task { roster.keepFresh(host: model.nativeHost) }
        .onChange(of: threads) { roster.refreshSoon(host: model.nativeHost) }
    }

    private func strip(_ row: DuckRowModel) -> some View {
        HStack(spacing: 0) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
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
    }

    /// The Duck's chat in the centre. Open or closed is not touched: A Closed Duck stays Closed while it is open.
    private func open(_ d: DuckRowAvatar) {
        guard let sessionId = d.sessionId else { return }
        model.openFromPond(.duck(sessionId), pond: key, page: RoomViewPref.shared.mode(for: key))
    }
}

/// One Duck: its tinted thread duck on a soft round tile, the name and a quiet status line beside it. The working glyph
/// only while it works, the amber triangle only while it waits on the person; a Closed Duck is dimmed.
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
            .opacity(duck.isOpen ? 1 : 0.6)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(duck.opensChat ? [("\(duck.name) \u{00B7} \(duck.presenceLine)"), duck.failed ? duck.needsYouWords : nil].compactMap { $0 }.joined(separator: "\n") : "\(duck.name) has no chat yet")
        .accessibilityLabel([ "\(duck.name), \(duck.presenceLine)", duck.failed ? duck.needsYouWords : nil].compactMap { $0 }.joined(separator: ", "))
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
                if duck.failed {
                    // A failure the person has not seen: the failed mark, and the chip opens that chat (which sees it).
                    Lucide(.circleX, size: 10, color: Theme.negative).frame(width: 15, height: 15)
                        .background(Theme.bg, in: Circle()).offset(x: 3, y: -3)
                } else if duck.needsYou {
                    Lucide(.triangleAlert, size: 10, color: Theme.warning).frame(width: 15, height: 15)
                        .background(Theme.bg, in: Circle()).offset(x: 3, y: -3)
                }
            }
            .accessibilityHidden(true)
    }
}
