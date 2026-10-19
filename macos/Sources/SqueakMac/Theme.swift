import AppKit
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// DESIGN.md §3 and §11 as SwiftUI colours (mirrors the iPhone app's Theme).
enum Theme {
    private static func adaptive(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        })
    }

    // Brand (DESIGN.md §3.1, §11). `duck` is a fill, never text on a light ground. `beak` and
    // `duckOutline` are the artwork's own colours: they are here to mirror §11, not for UI use.
    static let duck = Color(nsColor: NSColor(hex: Tokens.duck))
    static let duckWing = Color(nsColor: NSColor(hex: Tokens.duckWing))
    static let duckText = Color(nsColor: NSColor(hex: Tokens.duckText))

    // Neutrals (§3.2, §11).
    static let bg = adaptive(Tokens.Dark.bg, Tokens.Light.bg)
    static let sidebar = adaptive(Tokens.Dark.sidebar, Tokens.Light.sidebar)
    static let surface = adaptive(Tokens.Dark.surface, Tokens.Light.surface)
    /// Light is white, so anything raised also carries a `line` border.
    static let surfaceRaised = adaptive(Tokens.Dark.surfaceRaised, Tokens.Light.surfaceRaised)
    static let panelTranslucent = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 0.92) : NSColor(white: 1, alpha: 0.88)
    })
    static let panelGlass = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 24 / 255, green: 24 / 255, blue: 27 / 255, alpha: 0.40) : NSColor(white: 1, alpha: 0.45)
    })
    static let line = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.08) : NSColor(white: 0, alpha: 0.08)
    })
    static let lineStrong = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.14) : NSColor(white: 0, alpha: 0.16)
    })
    static let ink = adaptive(Tokens.Dark.ink, Tokens.Light.ink)
    static let muted = adaptive(Tokens.Dark.muted, Tokens.Light.muted)
    static let subtle = adaptive(Tokens.Dark.subtle, Tokens.Light.subtle)

    // State colours (§3.3). One colour per state, on the dot, the word and the badge only.
    static let needsYou = adaptive(Tokens.Dark.needsYou, Tokens.Light.needsYou)
    static let working = adaptive(Tokens.Dark.working, Tokens.Light.working)
    static let done = adaptive(Tokens.Dark.done, Tokens.Light.done)
    static let error = adaptive(Tokens.Dark.error, Tokens.Light.error)
    static let idle = adaptive(Tokens.Dark.idle, Tokens.Light.idle)
    static let offline = adaptive(Tokens.Dark.offline, Tokens.Light.offline)

    /// Primary button (§8.9): duck fill with ink text on dark; ink fill with white text on light,
    /// because yellow fails on white (§3.4). Pressed is `duck-wing` on dark, a touch lighter on light.
    static let primaryFill = adaptive(Tokens.duck, Tokens.Light.ink)
    static let primaryPressed = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(hex: Tokens.duckWing) : NSColor(hex: Tokens.Light.ink).withAlphaComponent(0.8)
    })
    static let primaryText = adaptive(Tokens.duckOutline, 0xFFFFFF)

    static func color(for state: SessionState) -> Color {
        switch state {
        case .working: working
        case .blocked: needsYou
        case .finished: done
        case .error: error
        case .idle, .unknown: idle
        }
    }

    static func label(for state: SessionState) -> String {
        switch state {
        case .working: "Working"
        case .blocked: "Needs you"
        case .finished: "Done"
        case .idle: "Idle"
        case .error: "Error"
        case .unknown: "Unknown"
        }
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1
        )
    }
}

/// DESIGN.md §8.1: pulses while working or needing you, unless Reduce Motion is on.
struct StateDot: View {
    let state: SessionState
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    private var pulses: Bool { state == .working || state == .blocked }

    var body: some View {
        Circle()
            .fill(Theme.color(for: state))
            .frame(width: 9, height: 9)
            .opacity(dim ? 0.35 : 1)
            .onAppear {
                guard !reduceMotion, pulses else { return }
                withAnimation(.easeInOut(duration: state == .working ? 0.8 : 0.5).repeatForever(autoreverses: true)) { dim = true }
            }
            .accessibilityHidden(true)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.label)
            .foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(
                isEnabled ? (configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill) : Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: Radius.control)
            )
            .overlay { if !isEnabled { RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line) } }
    }
}

/// Secondary (§8.9): surface-raised fill, ink text, line border.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.label)
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// Quiet (§8.9): text only, `muted`.
struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Typo.meta)
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, 10)
            .frame(minHeight: 26)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

/// Product type (§4.2). System fonts only; numbers that change use `.monospacedDigit()`.
enum Typo {
    static let title = Font.system(size: 20, weight: .semibold)
    static let heading = Font.system(size: 15, weight: .semibold)
    static let body = Font.system(size: 13)
    static let label = Font.system(size: 13, weight: .semibold)  // 550 is not a system weight
    static let meta = Font.system(size: 11)
    static let code = Font.system(size: 12, design: .monospaced)
}

extension MessageStyle {
    /// Messages in Squeak for Mac: DESIGN.md §4.2 sizes, §3.2 colours.
    static var squeak: MessageStyle {
        var s = MessageStyle.mac
        s.ink = Theme.ink; s.muted = Theme.muted; s.subtle = Theme.subtle; s.line = Theme.lineStrong
        s.codeSurface = Theme.surfaceRaised.opacity(0.45)
        s.tableHeader = Theme.surfaceRaised.opacity(0.55)
        return s
    }
}
