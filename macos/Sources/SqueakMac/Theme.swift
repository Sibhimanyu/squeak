import AppKit
import SqueakIcons
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
    /// Selected row, hover and the selected tab: one step above `surfaceRaised`.
    static let selected = adaptive(Tokens.Dark.selected, Tokens.Light.selected)
    static let selectedStrong = adaptive(Tokens.Dark.selectedStrong, Tokens.Light.selectedStrong)
    static let panelTranslucent = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 36 / 255, green: 33 / 255, blue: 30 / 255, alpha: 0.92) : NSColor(white: 1, alpha: 0.88)
    })
    static let panelGlass = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 36 / 255, green: 33 / 255, blue: 30 / 255, alpha: 0.40) : NSColor(white: 1, alpha: 0.45)
    })
    /// A grouped area inside the menu-bar panel, a step off the glass.
    static let panelBand = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: Tokens.Dark.selected).withAlphaComponent(0.6) : NSColor(white: 0, alpha: 0.045)
    })
    static let line = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.10) : NSColor(hex: Tokens.Light.selectedStrong)
    })
    static let lineStrong = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.20) : NSColor(srgbRed: 0.08, green: 0.06, blue: 0.06, alpha: 0.10)
    })
    static let ink = adaptive(Tokens.Dark.ink, Tokens.Light.ink)
    /// A file path inside text: the warm copper of the reference app on dark (DESIGN.md §3 notes `#CCA694`), `duck-text` on light.
    static let pathTint = adaptive(0xCCA694, Tokens.duckText)
    static let muted = adaptive(Tokens.Dark.muted, Tokens.Light.muted)
    static let subtle = adaptive(Tokens.Dark.subtle, Tokens.Light.subtle)

    // State colours (§3.3 v3). `negative`: failure and the destructive. `warning`: a thin glyph stroke and a card
    // edge only (§3.1). `working`: ocean blue, a chat at work. `done`: the unread dot, the duck's yellow, only for unread. `success` (green) is diffs and checks; `info` links.
    static let negative = adaptive(Tokens.Dark.negative, Tokens.Light.negative)
    static let warning = adaptive(Tokens.Dark.warning, Tokens.Light.warning)
    static let working = adaptive(Tokens.Dark.working, Tokens.Light.working)
    static let done = adaptive(Tokens.Dark.done, Tokens.Light.done)
    static let success = adaptive(Tokens.Dark.success, Tokens.Light.success)
    static let info = adaptive(Tokens.Dark.info, Tokens.Light.info)
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
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1
        )
    }
}

/// One mark drawn at its size (§8.1): the loader 12pt (grey; the quiet one at 70%), the glyphs 14pt, the unread dot 8pt.
struct ChatMarkGlyph: View {
    let mark: ChatMark

    var body: some View {
        switch mark.kind {
        case .working: WorkingMark(quiet: mark.quiet)
        case .waiting:
            switch mark.waiting ?? .answer {
            case .approval, .plan, .looping: Lucide(.triangleAlert, size: 14, color: Theme.warning).accessibilityHidden(true)
            case .answer: Lucide(.messageCircleQuestionMark, size: 14, color: Theme.muted).accessibilityHidden(true)
            }
        case .failed: Lucide(.circleX, size: 14, color: Theme.negative).accessibilityHidden(true)
        case .unread: Circle().fill(Theme.done).frame(width: 8, height: 8).accessibilityHidden(true)
        }
    }
}

/// The Working mark (§8.1): the matrix glyph (`MatrixActivity` indicator) in `muted`, 24x12 inside the 28x16 slot.
/// A still frame under Reduce Motion (the glyph checks it itself) and while the window is inactive.
struct WorkingMark: View {
    var quiet = false
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        MatrixActivity(style: .indicator, color: Theme.muted, quiet: quiet, still: scenePhase != .active)
            .frame(width: 24, height: 12)
            .accessibilityHidden(true)
    }
}

/// The fixed 28x16pt trailing slot of a row or tab (§8.1): the mark when there is one, else the age. A change
/// cross-fades in the same slot, and the mark carries its words as a tooltip.
struct MarkSlot: View {
    let mark: ChatMark?
    var words: String?
    var age: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            if let mark {
                ChatMarkGlyph(mark: mark).transition(.opacity)
            } else if let age {
                Text(RelativeAge.short(age)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle).lineLimit(1).transition(.opacity)
            }
        }
        .frame(width: 28, height: 16, alignment: .trailing)
        .animation(Motion.quick, value: mark?.kind)
        .help(mark.map { words ?? $0.words } ?? "")
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
            .pressFeedback(configuration.isPressed)
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
            .pressFeedback(configuration.isPressed)
    }
}

/// Every update action (footer, menu-bar banner, Settings): plain text, `ink` medium for the first, `muted` for the rest.
/// Never a filled or bordered button. Use with `.buttonStyle(.plain)`.
struct QuietAction: ViewModifier {
    let primary: Bool
    var size: CGFloat? = 12
    func body(content: Content) -> some View {
        content.font(size.map { .system(size: $0, weight: primary ? .medium : .regular) } ?? .callout.weight(primary ? .medium : .regular))
            .foregroundStyle(primary ? Theme.ink : Theme.muted)
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
            .pressFeedback(configuration.isPressed)
    }
}

/// Product type (§4.2). System fonts only; numbers that change use `.monospacedDigit()`.
enum Typo {
    static let title = Font.system(size: 20, weight: .semibold)
    static let heading = Font.system(size: 15, weight: .semibold)
    static let body = Font.system(size: 13)
    static let label = Font.system(size: 13, weight: .semibold)  // 550 is not a system weight
    static let meta = Font.system(size: 11)
    /// `footnote` (§4.2): the transcript's own small line, a turn's footer and the running time, 12/16.
    static let footnote = Font.system(size: 12)
    static let footnoteMono = Font.system(size: 12, design: .monospaced)
    /// `reading` (§4.2, §8.10): agent text in the transcript, 14/22.
    static let reading = Font.system(size: CGFloat(Tokens.Workbench.readingSize))
    static let code = Font.system(size: 12, design: .monospaced)
    /// `short-code` (§4.2): the invite's six characters, shown big on the invite sheet.
    static let shortCode = Font.system(size: 28, weight: .semibold, design: .monospaced)
}

extension MessageStyle {
    /// Agent text in the workbench transcript: `reading`, 14/22 (§4.2, §8.10); inline code is a `selected` chip.
    static var reading: MessageStyle {
        var s = MessageStyle.squeak
        s.bodySize = CGFloat(Tokens.Workbench.readingSize)
        s.lineSpacing = CGFloat(Tokens.Workbench.readingLeading)
        s.codeSurface = Theme.selected
        // Inline code is a chip (§8.10): `selected` fill, a 1 pt `line` border; a clickable path is tinted `pathTint`, not underlined.
        s.inlineCodeBorder = Theme.line
        s.pathTint = Theme.pathTint
        // Body is near-white (`ink` at 90%), not pure; bold and headings carry the full `ink` weight by being semibold.
        s.ink = Theme.ink.opacity(0.9)
        s.paragraphGap = CGFloat(Tokens.Workbench.paragraphGapEm)
        s.listGap = CGFloat(Tokens.Workbench.listGapEm)
        s.headingGapAbove = CGFloat(Tokens.Workbench.headingAboveEm)
        s.headingGapBelow = CGFloat(Tokens.Workbench.headingBelowEm)
        s.listItemGap = CGFloat(Tokens.Workbench.listItemGap)
        s.listIndentEm = CGFloat(Tokens.Workbench.listIndentEm)
        s.solidBullets = true
        s.inlineCodeScale = 0.9
        s.breakPaths = true
        s.letteredOptions = true
        return s
    }

    /// Messages in Squeak for Mac: DESIGN.md §4.2 sizes, §3.2 colours.
    static var squeak: MessageStyle {
        var s = MessageStyle.mac
        s.ink = Theme.ink; s.muted = Theme.muted; s.subtle = Theme.subtle; s.line = Theme.lineStrong
        s.codeSurface = Theme.surfaceRaised.opacity(0.45)
        s.tableHeader = Theme.surfaceRaised.opacity(0.55)
        s.selectableRuns = true
        return s
    }
}
