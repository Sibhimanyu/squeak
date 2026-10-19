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
            content
                .background(Color(nsColor: .controlBackgroundColor), in: shape)
                .overlay(shape.strokeBorder(Color(nsColor: .separatorColor)))
        } else if #available(macOS 26, *) {
            content.glassEffect(Self.style(tint, interactive), in: shape)
        } else {
            content
                .background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color(nsColor: .separatorColor)))
                .shadow(color: .black.opacity(0.10), radius: 8, y: 2)
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

/// The duck-yellow Send button: `.glassProminent` on macOS 26, a flat yellow rounded button before.
struct SendButtonStyle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26, *), !SqueakGlass.flat {
            content.buttonStyle(.glassProminent).tint(Theme.duck)
        } else {
            content.buttonStyle(YellowButtonStyle())
        }
    }
}

struct YellowButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 16).frame(minHeight: 30)
            .background(Theme.duck.opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.35), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// A bordered secondary button: `.glass` on macOS 26 (real captures), `.bordered` before and in flat captures.
struct GlassBorderedButton: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 26, *), !SqueakGlass.flat { content.buttonStyle(.glass) } else { content.buttonStyle(.bordered) }
    }
}
