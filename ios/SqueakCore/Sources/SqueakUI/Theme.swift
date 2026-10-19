#if os(iOS)
import SqueakCore
import SwiftUI
import UIKit

/// DESIGN.md §3 and §11, as SwiftUI colours. Change DESIGN.md first.
enum Theme {
    private static func adaptive(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(UIColor { traits in UIColor(hex: traits.userInterfaceStyle == .light ? light : dark) })
    }

    // Brand (§3.1, §11). The duck's colours are for the primary fill only;
    // nothing in the UI is yellow text or orange.
    static let duck = Color(UIColor(hex: 0xFFDA1A))
    static let duckWing = Color(UIColor(hex: 0xFFC812))
    static let beak = Color(UIColor(hex: 0xFF972E))
    static let duckOutline = Color(UIColor(hex: 0x18191B))
    static let duckText = Color(UIColor(hex: 0x8A5A00))
    static let bg = adaptive(0x09090B, 0xF4F4F5)
    static let sidebar = adaptive(0x0E0E11, 0xEBEBEC)
    static let surface = adaptive(0x18181B, 0xFFFFFF)
    static let surfaceRaised = adaptive(0x27272A, 0xFFFFFF)
    static let line = Color(UIColor { $0.userInterfaceStyle == .light ? UIColor(white: 0, alpha: 0.08) : UIColor(white: 1, alpha: 0.08) })
    static let lineStrong = Color(UIColor { $0.userInterfaceStyle == .light ? UIColor(white: 0, alpha: 0.16) : UIColor(white: 1, alpha: 0.14) })
    static let ink = adaptive(0xF4F4F5, 0x18181B)
    static let muted = adaptive(0xA1A1AA, 0x52525B)
    static let subtle = adaptive(0x71717A, 0x71717A)
    static let needsYou = adaptive(0xF87171, 0xDC2626)
    static let working = adaptive(0x22C55E, 0x15803D)
    static let idle = adaptive(0x71717A, 0x71717A)
    static let offline = adaptive(0x52525B, 0xA1A1AA)
    static let done = adaptive(0x38BDF8, 0x0369A1)
    static let error = adaptive(0xA78BFA, 0x7C3AED)

    /// DESIGN.md §8.9: duck-yellow on dark, ink-black on light (yellow fails on white).
    static let primaryFill = adaptive(0xFFDA1A, 0x18181B)
    static let primaryText = adaptive(0x18181B, 0xFFFFFF)

    static func stateColor(_ state: String) -> Color {
        switch state {
        case "awaiting_approval", "awaiting_input": return needsYou
        case "working": return working
        case "finished": return done
        case "error": return error
        default: return subtle
        }
    }
}

extension UIColor {
    convenience init(hex: UInt32) {
        self.init(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

/// The state dot (§8.1); pulses only when asked and never under Reduce Motion.
struct StatusDot: View {
    let color: Color
    var pulses = false
    var period = 1.0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 9, height: 9)
            .opacity(dim ? 0.35 : 1)
            .onAppear {
                guard pulses, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: period / 2).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

/// Liquid Glass on iOS 26 for the composer and option rows (DESIGN.md §5,
/// "Glass in the native apps"); the regular material before that; opaque
/// surface tokens under Reduce Transparency. Never given a state colour.
struct GlassSurface<S: Shape>: ViewModifier {
    let shape: S
    var interactive = false
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(Theme.surface, in: shape).overlay(shape.stroke(Theme.lineStrong))
        } else if #available(iOS 26, *) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            content.background(.regularMaterial, in: shape).overlay(shape.stroke(Theme.line))
        }
    }
}

/// Lets nearby glass share one sampling region on iOS 26.
struct GlassGroup<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View {
        if #available(iOS 26, *) { GlassEffectContainer(spacing: 10) { content } } else { content }
    }
}

extension View {
    func glassSurface<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        modifier(GlassSurface(shape: shape, interactive: interactive))
    }
}

/// The one loud control (DESIGN.md §8.9).
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                isEnabled ? Theme.primaryFill.opacity(configuration.isPressed ? 0.8 : 1) : Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: 8)
            )
    }
}
#endif
