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
                        let opacity = 0.20 + 0.20 * (0.5 + 0.5 * sin(time * 0.7 + Double(column + row)))
                        graphics.draw(Text(symbols[index]).font(.system(size: 12, weight: .medium, design: .monospaced))
                            .foregroundStyle(color.opacity(opacity)),
                            at: CGPoint(x: CGFloat(column) * 23 + advance, y: CGFloat(row) * 12 + 2))
                    }
                }
            }
        }
        .blur(radius: 0.2).clipped().allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// Foreground activity must be legible at phone scale; it does not inherit the background texture's low alpha.
struct GlyphLoader: View {
    var size: CGFloat = 14
    var quiet = false
    var color: Color = Theme.ink
    var still = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: reduceMotion || still)) { context in
            Canvas { graphics, canvas in
                let time = reduceMotion || still ? 0 : context.date.timeIntervalSinceReferenceDate
                for (index, symbol) in ["{", "/", "}"].enumerated() {
                    let wave = 0.5 + 0.5 * sin(time * 4 - Double(index) * 1.4)
                    let alpha = reduceMotion || still ? 0.85 : 0.40 + 0.60 * wave
                    graphics.draw(Text(symbol).font(.system(size: size, weight: .semibold, design: .monospaced))
                        .foregroundStyle(color.opacity(quiet ? max(0.55, alpha * 0.85) : alpha)),
                        at: CGPoint(x: (CGFloat(index) + 0.5) * canvas.width / 3, y: canvas.height / 2))
                }
            }
        }
        .frame(width: max(30, size * 2.5), height: max(18, size * 1.3))
        .clipped().allowsHitTesting(false)
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
