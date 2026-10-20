import AppKit
import SwiftUI

/// Liquid Glass where macOS 26 has it, a material elsewhere (and a solid fill under Reduce
/// Transparency). `cacheDisplay` cannot draw glass or materials, so offscreen captures get a flat
/// stand-in unless SQUEAK_MAC_GLASS=1 (used for the on-screen capture).
struct SqueakGlass: ViewModifier {
    var radius: CGFloat
    var tint: Color?
    var interactive = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    static var flat: Bool {
        let env = ProcessInfo.processInfo.environment
        return env["SQUEAK_MAC_CAPTURE"] != nil && env["SQUEAK_MAC_GLASS"] != "1"
    }

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if Self.flat || reduceTransparency {
            // Reduce Transparency (and flat captures): the opaque tokens, no glass (DESIGN.md §5).
            content
                .background(Theme.surfaceRaised, in: shape)
                .overlay(shape.strokeBorder(Theme.line))
        } else if #available(macOS 26, *) {
            content.glassEffect(Self.style(tint, interactive), in: shape)
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Theme.line))
        }
    }

    @available(macOS 26, *)
    private static func style(_ tint: Color?, _ interactive: Bool) -> Glass {
        var g: Glass = .regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
}

extension View {
    func squeakGlass(radius: CGFloat, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(SqueakGlass(radius: radius, tint: tint, interactive: interactive))
    }
}

/// Groups glass shapes so they sample one region (glass cannot sample glass).
struct SqueakGlassGroup<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if #available(macOS 26, *), !SqueakGlass.flat, !reduceTransparency {
            GlassEffectContainer(spacing: spacing) { content }
        } else {
            content
        }
    }
}

/// Send (§8.9, §5): the prominent glass button on macOS 26, filled with the primary fill (`duck` on
/// dark, ink on light, since yellow fails on white); the flat primary button before 26 and under
/// Reduce Transparency.
struct SendButtonStyle: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if #available(macOS 26, *), !SqueakGlass.flat, !reduceTransparency {
            content.buttonStyle(.glassProminent).tint(Theme.primaryFill)
        } else {
            content.buttonStyle(PrimaryButtonStyle())
        }
    }
}

/// A secondary button (§8.9): surface-raised fill, ink text, line border.
struct GlassBorderedButton: ViewModifier {
    func body(content: Content) -> some View { content.buttonStyle(SecondaryButtonStyle()) }
}
