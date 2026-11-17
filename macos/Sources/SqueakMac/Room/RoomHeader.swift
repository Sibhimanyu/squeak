import SqueakIcons
import SqueakMacCore
import SwiftUI

// The room's chrome: the header (pond icon and name, member avatars, a state summary built from marks, the Room |
// Dashboard switch) and the segmented control both it and the Ripples filters use. Colour only on marks.

/// Which of the pond's two pages a person lands on, remembered per pond.
@MainActor @Observable
final class RoomViewPref {
    static let shared = RoomViewPref()
    enum Mode: String, CaseIterable { case room, dashboard
        var title: String { self == .room ? "Room" : "Dashboard" }
    }
    private static let defaultsKey = "pondRoomMode"
    private(set) var modes: [String: String] = UserDefaults.standard.dictionary(forKey: RoomViewPref.defaultsKey) as? [String: String] ?? [:]

    func mode(for key: String) -> Mode { modes[key].flatMap(Mode.init(rawValue:)) ?? .room }
    func set(_ mode: Mode, for key: String) {
        modes[key] = mode.rawValue
        UserDefaults.standard.set(modes, forKey: Self.defaultsKey)
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
                    Text(verbatim: title(item)).font(.system(size: 13, weight: on ? .medium : .regular))
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .padding(.horizontal, 12).frame(height: height - 4)
                        .background(on ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(title(item)).accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2).background(Theme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line))
        .animation(reduceMotion ? nil : Motion.quick, value: selection)
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
    let summary: RoomSummary.Line
    var leadingInset: CGFloat = 0
    @Environment(AppModel.self) private var model
    private var ponds: PondsModel { .shared }

    var body: some View {
        let pond = ponds.pond(key: key)
        let name = ponds.name(key: key)
        HStack(spacing: Space.m) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            PondTile(name: name, pondId: pond?.id, projectId: ponds.native(key: key)?.id, size: 24)
            Text(verbatim: name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            avatars(pond)
            summaryView
            Spacer(minLength: Space.s)
            RoomModeSwitch(key: key)
        }
        .padding(.horizontal, Space.xl).frame(height: Metrics.header).background(WindowDragArea())
    }

    private func avatars(_ pond: PondSummary?) -> some View {
        let members = ponds.detail(key: key).map { PondFlock.ordered($0.members, presence: $0.presence) } ?? []
        let shown = Array(members.prefix(4))
        return HStack(spacing: -6) {
            ForEach(shown) { m in
                FlockAvatar(member: m, online: false, size: 24)
                    .overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2))
            }
            if members.count > shown.count {
                Text("+\(members.count - shown.count)").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
                    .frame(width: 24, height: 24).background(Theme.selected, in: Circle()).overlay(Circle().strokeBorder(Theme.bg, lineWidth: 2))
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("\(members.count) people in this pond")
    }

    @ViewBuilder private var summaryView: some View {
        HStack(spacing: Space.m) {
            if summary.quiet {
                Text("All quiet").font(.system(size: 13)).foregroundStyle(Theme.ink)
                if let d = summary.quietDetail { Text(verbatim: d).font(.system(size: 13)).foregroundStyle(Theme.subtle) }
            } else {
                if summary.working > 0 {
                    HStack(spacing: 6) {
                        WorkingGlyph(slot: 22, alignment: .leading, grid: .micro)
                        Text("\(summary.working) working").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
                if summary.needsYou > 0 {
                    HStack(spacing: 6) {
                        Lucide(.triangleAlert, size: 14, color: Theme.warning)
                        Text("\(summary.needsYou) needs you").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .lineLimit(1).padding(.leading, Space.xs)
    }
}
