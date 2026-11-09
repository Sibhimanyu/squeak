#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A ghost of a moving command surface, clipped behind crisp tab titles. No text is taken from a chat.
/// Idle views don't instantiate this timeline. Reduce Motion keeps one quiet, static frame.
struct GlyphLoadingField: View {
    var color: Color = Theme.muted
    var still = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: reduceMotion || still)) { context in
            Canvas { graphics, size in
                let time = reduceMotion || still ? 0 : context.date.timeIntervalSinceReferenceDate
                let symbols = ["{", "/", "}", "·", "_", "⌁", ":", ">"]
                let advance = (time * 9).truncatingRemainder(dividingBy: 23)
                for row in 0..<3 {
                    for column in -1...Int(size.width / 23) + 1 {
                        let index = abs(column + row * 3) % symbols.count
                        let opacity = 0.08 + 0.10 * (0.5 + 0.5 * sin(time * 0.7 + Double(column + row)))
                        graphics.draw(Text(symbols[index]).font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(color.opacity(opacity)),
                            at: CGPoint(x: CGFloat(column) * 23 + advance, y: CGFloat(row) * 12 + 2))
                    }
                }
            }
        }
        .blur(radius: 0.6).clipped().allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// A compact glyph strip for work that waits on the Mac or a network response.
struct GlyphLoader: View {
    var size: CGFloat = 14
    var quiet = false
    var color: Color = Theme.muted
    var still = false

    var body: some View {
        GlyphLoadingField(color: color, still: still)
            .frame(width: max(24, size * 1.8), height: size)
            .opacity(quiet ? 0.7 : 1)
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
