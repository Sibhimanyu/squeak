#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// An abstract pixel matrix behind running titles. Text stays sharp above the cell field.
struct GlyphLoadingField: View {
    var color: Color = Theme.muted
    var still = false

    var body: some View {
        MatrixActivity(style: .field, color: color, still: still).blur(radius: 0.25)
    }
}

/// The foreground matrix uses brighter, crisp pixels at phone scale, not the background's faint treatment.
struct GlyphLoader: View {
    var size: CGFloat = 14
    var quiet = false
    var color: Color = Theme.ink
    var still = false

    var body: some View {
        MatrixActivity(style: .indicator, color: color, quiet: quiet, still: still)
            .frame(width: max(34, size * 2.5), height: max(20, size * 1.4))
            .accessibilityElement(children: .ignore)
            .accessibilityHidden(false)
            .accessibilityLabel("Loading")
    }
}

extension View {
    /// Only running rows create an animation timeline. The text above it stays crisp.
    @ViewBuilder func runningGlyphs(_ active: Bool, still: Bool = false) -> some View {
        background {
            if active { GlyphLoadingField(still: still).clipShape(RoundedRectangle(cornerRadius: 6)) }
        }
    }
}

/// The glyphs of a mark, one place: failed `circle-x` in `negative`, approval and plan `triangle-alert` in
/// `warning`, a question `message-circle-question-mark` in `muted`.
enum MarkGlyph {
    /// A card or row's left edge: `warning` for an approval or a plan, `subtle` (grey) for a question.
    static func edge(_ session: PhoneSnapshot.Session) -> Color { waitingIcon(session).icon == .triangleAlert ? Theme.warning : Theme.subtle }

    static func waitingIcon(_ session: PhoneSnapshot.Session) -> (icon: LucideName, color: Color) {
        Presentation.waitingKind(session) == .question ? (.messageCircleQuestionMark, Theme.muted) : (.triangleAlert, Theme.warning)
    }
}
#endif
