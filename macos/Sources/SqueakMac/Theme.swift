import AppKit
import SqueakMacCore
import SwiftUI

/// DESIGN.md §3 and §11 as SwiftUI colours (mirrors the iPhone app's Theme).
enum Theme {
    private static func adaptive(_ dark: UInt32, _ light: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        })
    }

    static let duck = Color(nsColor: NSColor(hex: 0xFCD02C))
    static let bg = adaptive(0x09090B, 0xF4F4F5)
    static let sidebar = adaptive(0x0E0E11, 0xEBEBEC)
    static let surface = adaptive(0x18181B, 0xFFFFFF)
    static let surfaceRaised = adaptive(0x27272A, 0xE4E4E7)
    static let line = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.08) : NSColor(white: 0, alpha: 0.09)
    })
    static let ink = adaptive(0xF4F4F5, 0x18181B)
    static let muted = adaptive(0xA1A1AA, 0x52525B)
    static let subtle = adaptive(0x71717A, 0x71717A)
    static let needsYou = adaptive(0xF87171, 0xDC2626)
    /// Amber for "needs you" in the Squeak window: the one thing asking for attention.
    static let attention = adaptive(0xFBBF24, 0xB45309)
    static let attentionDot = adaptive(0xFBBF24, 0xE8A400)
    static let working = adaptive(0x22C55E, 0x15803D)
    static let done = adaptive(0x38BDF8, 0x0369A1)
    static let error = adaptive(0xA78BFA, 0x7C3AED)
    /// Duck-yellow on dark, ink-black on light (yellow fails on white): DESIGN.md §8.9.
    static let primaryFill = adaptive(0xFCD02C, 0x18181B)
    static let primaryText = adaptive(0x18181B, 0xFFFFFF)
    static let userBubble = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(hex: 0xFCD02C).withAlphaComponent(0.14) : NSColor(hex: 0xFCD02C).withAlphaComponent(0.35)
    })

    static func color(for state: SessionState) -> Color {
        switch state {
        case .working: working
        case .blocked: needsYou
        case .finished: done
        case .error: error
        case .idle, .unknown: subtle
        }
    }

    static func label(for state: SessionState) -> String {
        switch state {
        case .working: "Working"
        case .blocked: "Needs you"
        case .finished: "Finished"
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
            .frame(width: 8, height: 8)
            .opacity(dim ? 0.4 : 1)
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
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
            .padding(.horizontal, 12)
            .frame(minHeight: 28)
            .background(
                isEnabled ? Theme.primaryFill.opacity(configuration.isPressed ? 0.8 : 1) : Theme.surfaceRaised,
                in: RoundedRectangle(cornerRadius: 8)
            )
    }
}

struct QuietButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 10)
            .frame(minHeight: 26)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: 8))
    }
}

func agentSymbol(_ session: HostSession) -> String {
    switch session.agent?.lowercased() {
    case "claude": "sparkle"
    case "codex": "chevron.left.forwardslash.chevron.right"
    default: "bubble.left"
    }
}
