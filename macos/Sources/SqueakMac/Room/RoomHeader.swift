import SqueakIcons
import SqueakMacCore
import SwiftUI

// The room's chrome: the header (pond icon and name, member avatars, a state summary built from marks, the Room |
// Dashboard switch) and the segmented control both it and the Ripples filters use. Colour only on marks.

/// Which of the pond's two pages is showing, remembered per pond for the session only: a pond opens on its Dashboard,
/// and what the person last picked holds until the app quits.
@MainActor @Observable
final class RoomViewPref {
    static let shared = RoomViewPref()
    typealias Mode = PondPage
    private(set) var modes: [String: PondPage] = [:]

    func mode(for key: String) -> Mode { modes[key] ?? .dashboard }
    /// Every writer lands here (the switch, a swipe, Esc, a deep link, the way back from a tab), so the strip is sent to the
    /// page in the same step: the pill and the pages never wait a frame on each other.
    func set(_ mode: Mode, for key: String) {
        modes[key] = mode
        PondPanStore.shared.state(for: key).reconcile(page: mode)
    }
}

/// A small segmented control: a `surface` track, the selected item raised.
struct RoomSegmented<T: Hashable>: View {
    let items: [T]
    @Binding var selection: T
    let title: (T) -> String
    var height: CGFloat = 26
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.self) { item in
                let on = item == selection
                Button { selection = item } label: {
                    Text(verbatim: title(item)).font(.system(size: 13, weight: on ? .medium : .regular)).lineLimit(1).fixedSize()
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .padding(.horizontal, 12).frame(height: height - 4)
                        .background(on ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title(item)).accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.surface)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line))
        }
        .animation(reduceMotion ? nil : Motion.quick, value: selection)
    }
}

/// The top bar's Dashboard | Room switch: a glass track with a raised pill under the page that shows. The selection is the
/// one `PondCentre` says (`selection`, nil while a Duck or an item covers the pages: no pill). While the two-finger swipe moves
/// the strip, or the strip springs to a page, the pill slides between the segments with the strip's own position, so it lands
/// with the page; at rest it sits under the selection. Segment widths are measured from the label font, so the pill's track
/// is exact by construction (no layout pass needed to know where a segment is).
struct PondPageSwitch: View {
    let selection: PondPage?
    /// The pond's strip, read only here and in the pages' own modifiers, never by the bar.
    var strip: PondPanState?
    /// A fixed progress for snapshots (0 Dashboard ... 1 Room).
    var progress: Double?
    let pick: (PondPage) -> Void

    private static let font = Font.system(size: 13, weight: .medium)
    private static let pad: CGFloat = 12
    private static let gap: CGFloat = 2
    private static let inset: CGFloat = 2

    private static func width(of page: PondPage) -> CGFloat {
        let w = (page.title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: .medium)]).width
        return ceil(w) + pad * 2
    }

    var body: some View {
        let height = CGFloat(PondBarMetrics.controlHeight)
        let dash = Self.width(of: .dashboard), room = Self.width(of: .room)
        let at: Double? = selection == nil ? nil : (progress ?? PondSwitchIndicator.progress(selection: selection, strip: strip?.moving))
        let pill = at.map {
            PondSwitchIndicator.pill(progress: $0, dashboard: (0, Double(dash)), room: (Double(dash + Self.gap), Double(room)))
        }
        HStack(spacing: Self.gap) {
            segment(.dashboard, width: dash, height: height - 2 * Self.inset, at: at)
            segment(.room, width: room, height: height - 2 * Self.inset, at: at)
        }
        .padding(Self.inset)
        .background(alignment: .topLeading) {
            if let pill {
                Capsule().fill(TopSurfaceGlass.switchPill)
                    .shadow(color: TopSurfaceGlass.tabShadow, radius: 2, y: 1)
                    .frame(width: CGFloat(pill.width), height: height - 2 * Self.inset)
                    .offset(x: Self.inset + CGFloat(pill.x), y: Self.inset)
            }
        }
        .background(Capsule().fill(TopSurfaceGlass.switchTrack))
        .fixedSize()
        .accessibilityElement(children: .contain).accessibilityLabel("Pond view")
    }

    private func segment(_ page: PondPage, width: CGFloat, height: CGFloat, at: Double?) -> some View {
        let w = at.map { PondSwitchIndicator.weight(of: page, progress: $0) } ?? 0
        return Button { pick(page) } label: {
            Text(verbatim: page.title).font(Self.font).lineLimit(1).fixedSize()
                .foregroundStyle(Theme.muted)
                .overlay { Text(verbatim: page.title).font(Self.font).lineLimit(1).fixedSize().foregroundStyle(Theme.ink).opacity(w) }
                .frame(width: width, height: height)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(page.title).accessibilityAddTraits(selection == page ? .isSelected : [])
    }
}

/// The Room | Dashboard switch for one pond.
struct RoomModeSwitch: View {
    let key: String
    var body: some View {
        RoomSegmented(
            items: RoomViewPref.Mode.allCases,
            selection: Binding(get: { RoomViewPref.shared.mode(for: key) }, set: { RoomViewPref.shared.set($0, for: key) }),
            title: \.title, height: 28)
            .accessibilityLabel("Pond view")
    }
}

struct RoomHeader: View {
    let key: String
    let ducks: [RoomDuck]
    let open: (String) -> Void
    var leadingInset: CGFloat = 0
    /// Every duck of the pond (the inspector's list); the page's threads hold only the recent ones.
    @Environment(AppModel.self) private var model
    private var ponds: PondsModel { .shared }

    var body: some View {
        let pond = ponds.pond(key: key)
        let name = ponds.name(key: key)
        let people = ponds.detail(key: key)?.members.count ?? 1
        HStack(spacing: Space.m) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            PondTile(name: name, pondId: pond?.id, projectId: ponds.native(key: key)?.id, size: 28)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                Text(verbatim: RoomDucks.subtitle(people: people, ducks: ducks.count, connection: pond?.connection)).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
            }
            Spacer(minLength: Space.s)
            // New layout: the Duck row above the page carries the Ducks, so the header does not repeat them.
            if !(MacLayoutPreference.shared.isNew && DuckAvatarRowView.isAvailable(pond: key)) {
                HStack(spacing: 14) {
                    ForEach(ducks.prefix(8)) { d in
                        Button { open(d.sessionId) } label: { HeaderDuck(duck: d) }.buttonStyle(.plain).help("\(d.name) \u{00B7} \(d.presenceLine)")
                    }
                }
                .padding(.trailing, 6)
            }
            RoomModeSwitch(key: key)
            PondHeaderMenu(key: key)
        }
        .padding(.horizontal, Space.xl).frame(height: Metrics.header).background(WindowDragArea())
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
    }
}

/// A duck in the header: its avatar with the state mark at the corner (tide while working, triangle while it waits).
private struct HeaderDuck: View {
    let duck: RoomDuck
    var body: some View {
        DuckAvatar(sessionId: duck.sessionId, agent: duck.agent, size: 30, off: !duck.isOpen)
            .overlay(alignment: .topTrailing) {
                switch duck.presence {
                case .working: WorkingGlyph(slot: 12, alignment: .center, grid: .micro).scaleEffect(0.8).frame(width: 14, height: 14).background(Theme.bg, in: Circle()).offset(x: 5, y: -5)
                case .waiting: Lucide(.triangleAlert, size: 10, color: Theme.warning).frame(width: 14, height: 14).background(Theme.bg, in: Circle()).offset(x: 5, y: -5)
                case .idle, .off: EmptyView()
                }
            }
            .accessibilityElement(children: .ignore).accessibilityLabel("\(duck.name), \(duck.presenceLine)")
    }
}
