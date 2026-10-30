import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar popup's own pieces, drawn to the generated mockups: a 360pt panel, bordered cards, a
/// raised-pill tab bar, bordered segmented controls, green switches, flat buttons. Everything is a thin
/// ink overlay on the panel's glass, so light and dark both follow the system.
enum PopupMetrics {
    /// The one left/right content inset of every popup screen. `PopupScaffold` applies it once around the
    /// top, the band and the footer; nothing inside adds horizontal padding of its own beyond a card's.
    static let inset: CGFloat = 14
    static let cardRadius: CGFloat = 12
    static let controlRadius: CGFloat = 8
}

extension Font {
    static func popup(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font { .system(size: size, weight: weight) }
}

extension Color {
    /// A thin ink wash: the card, row and pill fills of the mockups.
    static func wash(_ amount: Double) -> Color { Theme.ink.opacity(amount) }
}

/// A bordered surface: the card of every popup screen.
struct PopupCardModifier: ViewModifier {
    var radius: CGFloat = PopupMetrics.cardRadius
    var fill: Double = 0.045
    var stroke: Double = 0.10

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Color.wash(fill)))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.wash(stroke), lineWidth: 1))
    }
}

extension View {
    func popupCard(radius: CGFloat = PopupMetrics.cardRadius, fill: Double = 0.045, stroke: Double = 0.10) -> some View {
        modifier(PopupCardModifier(radius: radius, fill: fill, stroke: stroke))
    }
}

/// A hairline across the panel's content width.
struct PopupDivider: View {
    var body: some View { Rectangle().fill(Color.wash(0.09)).frame(height: 1).accessibilityHidden(true) }
}

/// A flat button: wash fill, thin border, ink label. `primary` is the duck-yellow fill (the only place
/// yellow is a fill); `danger` the red outline of Stop.
struct PopupButtonStyle: ButtonStyle {
    enum Kind { case plain, primary, danger }
    var kind: Kind = .plain
    var radius: CGFloat = PopupMetrics.controlRadius
    var height: CGFloat = Metrics.button
    var hPad: CGFloat = 12
    var size: CGFloat = 13
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        configuration.label
            .font(.popup(size, kind == .plain ? .medium : .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, hPad)
            .frame(height: height)
            .background(shape.fill(fill(configuration.isPressed)))
            .overlay { if kind != .primary || !isEnabled { shape.strokeBorder(stroke, lineWidth: 1) } }
            .opacity(isEnabled ? 1 : (kind == .primary ? 1 : 0.5))
            .contentShape(shape)
    }

    private var foreground: Color {
        switch kind {
        case .plain: Theme.ink
        case .primary: isEnabled ? Theme.primaryText : Theme.muted
        case .danger: Theme.needsYou
        }
    }

    private func fill(_ pressed: Bool) -> Color {
        switch kind {
        case .plain: Color.wash(pressed ? 0.12 : 0.07)
        case .primary: isEnabled ? (pressed ? Theme.primaryPressed : Theme.primaryFill) : Color.wash(0.07)
        case .danger: Color.wash(pressed ? 0.06 : 0.0)
        }
    }

    private var stroke: Color {
        switch kind {
        case .plain: Color.wash(0.12)
        case .primary: Color.wash(0.12)
        case .danger: Theme.needsYou.opacity(0.85)
        }
    }
}

/// A bordered segmented control: one rounded track, the selected segment a raised pill, thin dividers
/// between the others (the awake lengths, thinking level, power mode).
struct PopupSegmented<ID: Hashable>: View {
    var items: [(id: ID, title: String)]
    var selection: ID?
    var height: CGFloat = Metrics.segmented
    var size: CGFloat = 12.5
    var enabled = true
    /// The mark before an item's title (the agent switch).
    var mark: ((ID) -> AgentMarkAsset?)? = nil
    var onPick: (ID) -> Void

    var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.offset) { i, item in
                let on = item.id == selection
                let nextOn = i + 1 < items.count && items[i + 1].id == selection
                Button { onPick(item.id) } label: {
                    HStack(spacing: 6) {
                        if let m = mark?(item.id) { AgentMark(m, size: size + 3.5) }
                        Text(item.title)
                    }
                        .font(.popup(size, on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .lineLimit(1).minimumScaleFactor(0.8)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background {
                            if on {
                                RoundedRectangle(cornerRadius: PopupMetrics.controlRadius - 2, style: .continuous).fill(Theme.selectedStrong)
                                    .overlay(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius - 2, style: .continuous).strokeBorder(Color.wash(0.10)))
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                .accessibilityAddTraits(on ? .isSelected : [])
                if i + 1 < items.count {
                    Rectangle().fill(Color.wash(on || nextOn ? 0 : 0.10)).frame(width: 1, height: height * 0.5)
                }
            }
        }
        .padding(2.5)
        .frame(height: height)
        .background(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius + 1, style: .continuous).fill(Color.wash(0.03)))
        .overlay(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius + 1, style: .continuous).strokeBorder(Color.wash(0.11)))
    }
}

/// A full-width popup button with a trailing chevron: the Model and worker pickers.
struct PopupMenuField<Tag: Hashable>: View {
    var label: String
    var selection: Binding<Tag>
    var options: [(tag: Tag, title: String)]
    var height: CGFloat = Metrics.field
    /// The mark that goes before an option's name (the agent picker), in the menu and on the closed field.
    var mark: ((Tag) -> AgentMarkAsset?)? = nil

    var body: some View {
        Menu {
            Picker(label, selection: selection) {
                ForEach(options.indices, id: \.self) { i in
                    if let m = mark?(options[i].tag), let img = AgentMarkImages.sized(m, 16) {
                        Label { Text(options[i].title) } icon: { Image(nsImage: img) }.tag(options[i].tag)
                    } else {
                        Text(options[i].title).tag(options[i].tag)
                    }
                }
            }.pickerStyle(.inline).labelsHidden()
        } label: {
            HStack(spacing: 6) {
                if let m = mark?(selection.wrappedValue) { AgentMark(m, size: 16) }
                Text(options.first { $0.tag == selection.wrappedValue }?.title ?? "").font(.popup(13)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 4)
                Lucide(.chevronDown, size: 14, color: Theme.ink)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: height, maxHeight: height)
            .popupCard(radius: PopupMetrics.controlRadius, fill: 0.04, stroke: 0.12)
            .contentShape(Rectangle())
        }
        .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden)
        .accessibilityLabel(label)
    }
}

/// The normal green system switch.
struct PopupSwitch: View {
    var label: String
    @Binding var isOn: Bool
    var enabled = true

    var body: some View {
        Button { isOn.toggle() } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule().fill(isOn ? Theme.working : Color.wash(0.22))
                Circle().fill(Color.white).frame(width: 18, height: 18).padding(2).shadow(color: .black.opacity(0.25), radius: 1, y: 0.5)
            }
            .frame(width: 38, height: 22)
            .opacity(enabled ? 1 : 0.45)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityValue(isOn ? "on" : "off")
        .accessibilityAddTraits(.isToggle)
    }
}

/// A row in a card: an icon, a title and a trailing control.
struct PopupIconRow<Trailing: View>: View {
    var icon: AnyView
    var title: String
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 10) {
            icon.frame(width: 20, height: 20)
            Text(title).font(.popup(13)).foregroundStyle(Theme.ink).lineLimit(1)
            Spacer(minLength: 8)
            trailing
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .contain)
    }
}

/// SF Symbols for the few glyphs Lucide's bundled set lacks, drawn light so they sit with it.
struct PopupSymbol: View {
    var name: String
    var size: CGFloat = 14
    var color: Color = Theme.muted

    var body: some View {
        Image(systemName: name).font(.system(size: size, weight: .light)).foregroundStyle(color)
            .frame(width: size + 4, height: size + 4).accessibilityHidden(true)
    }
}

/// Three vertical bars: the Usage tab's glyph.
struct PopupBarsGlyph: View {
    var size: CGFloat = 14
    var color: Color = Theme.muted

    var body: some View {
        Canvas { ctx, s in
            let w = s.width, h = s.height
            for (i, top) in [0.55, 0.0, 0.3].enumerated() {
                var p = Path()
                let x = w * (0.22 + 0.28 * CGFloat(i))
                p.move(to: CGPoint(x: x, y: h * (0.22 + top * 0.5)))
                p.addLine(to: CGPoint(x: x, y: h * 0.82))
                ctx.stroke(p, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            }
        }
        .frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// Red count badge (the Needs you tab).
struct PopupBadge: View {
    var count: Int
    var body: some View {
        Text("\(count)").font(.popup(11, .semibold)).foregroundStyle(Color.white).monospacedDigit()
            .frame(minWidth: 16, minHeight: 16)
            .padding(.horizontal, count > 9 ? 4 : 0)
            .background(Capsule().fill(Theme.needsYou))
            .accessibilityLabel("\(count) need you")
    }
}

/// A thin progress track: ink for usage, green for the awake countdown.
struct PopupBar: View {
    var fraction: Double
    var fill: Color
    var track: Color = Color.wash(0.14)
    var height: CGFloat = 8

    var body: some View {
        GeometryReader { p in
            ZStack(alignment: .leading) {
                Capsule().fill(track)
                Capsule().fill(fill).frame(width: max(p.size.width * min(max(fraction, 0), 1), fraction > 0 ? height : 0))
            }
        }
        .frame(height: height).accessibilityHidden(true)
    }
}

/// The screen's top row: an optional back button, a title (or any leading view) and trailing controls.
struct PopupBackButton: View {
    var action: () -> Void
    var bordered = false

    var body: some View {
        Button(action: action) {
            Lucide(.arrowLeft, size: 14, label: "Back", color: Theme.ink)
                .frame(width: 28, height: 26)
                .background { if bordered { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.wash(0.06)) } }
                .overlay { if bordered { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color.wash(0.12)) } }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .keyboardShortcut(.leftArrow, modifiers: .command)
    }
}
