import AppKit
import SqueakMacCore
import SwiftUI

// DESIGN.md §3.1 and §8.10, the Pond colour pass. Duck yellow is the accent (the selected pond, the primary buttons
// on Pond surfaces, your avatar's ring) and never a state or a warning. Each pond has a soft tint derived from its
// id, and people have avatar colours; both are `PondTint`'s (SqueakMacCore), measured for contrast in its tests.

enum PondColour {
    private static func dynamic(_ f: @escaping (_ dark: Bool) -> NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in f(appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua) })
    }

    private static func ns(_ c: PondTint.RGB) -> NSColor { NSColor(srgbRed: c.r, green: c.g, blue: c.b, alpha: 1) }

    /// The selected pond's accent and your avatar's ring: duck on dark; on light `duck-text`, because duck itself is
    /// 1.37:1 on white (§3.4) and an accent has to be seen.
    static let accent = dynamic { $0 ? NSColor(hex: Tokens.duck) : NSColor(hex: Tokens.duckText) }

    /// A pond's soft tint; a project not in a pond has none (`selected`).
    /// The chosen named colour when the pond has one, else the hue from its id.
    @MainActor static func tint(_ pondId: String?) -> Color {
        guard let pondId else { return Theme.selected }
        if let hue = PondsModel.shared.colourHue(forPondId: pondId) { return dynamic { ns(PondTint.rgb(hue: hue, dark: $0)) } }
        return dynamic { ns(PondTint.rgb(for: pondId, dark: $0)) }
    }

    /// A swatch of a named colour (the settings row).
    static func swatch(hue: Double) -> Color { dynamic { ns(PondTint.rgb(hue: hue, dark: $0)) } }

    /// A person's colour: stable from their name.
    static func avatar(_ index: Int) -> Color {
        dynamic { ns(PondTint.avatar(index: index, dark: $0)) }
    }

    /// A primary button's fill and label: ink on duck in both appearances (12.9:1, §3.4).
    static let primaryFill = Color(nsColor: NSColor(hex: Tokens.duck))
    static let primaryPressed = Color(nsColor: NSColor(hex: Tokens.duckWing))
    static let primaryText = Color(nsColor: NSColor(hex: Tokens.duckOutline))
}

/// §8.9's primary on a Pond surface: duck fill, ink label, light and dark. Elsewhere the primary is unchanged.
struct PondPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.label)
            .foregroundStyle(isEnabled ? PondColour.primaryText : Theme.muted)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(
                isEnabled ? (configuration.isPressed ? PondColour.primaryPressed : PondColour.primaryFill) : Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Radius.control))
    }
}
