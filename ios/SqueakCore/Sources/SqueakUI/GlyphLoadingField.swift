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
            if active { GlyphLoadingField(still: still) }
        }
    }
}

/// A trailing activity mark. It never takes the agent's icon slot or paints behind the title.
struct ChatActivityGlyph: View {
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .subheadline) private var width = 104.0
    @ScaledMetric(relativeTo: .subheadline) private var height = 32.0

    var body: some View {
        MatrixActivity(style: .indicator, color: model.macIsLive ? Theme.activity : Theme.subtle,
                       still: !model.macIsLive)
            .frame(width: min(width, 120), height: min(height, 44))
            .accessibilityHidden(true)
    }
}

/// A passing pool of light picks out the letters and casts a small halo, keeping the base text readable.
private struct RunningTextLight: ViewModifier {
    let active: Bool
    let still: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        if active {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1.0 / 15,
                                        paused: reduceMotion || still || scenePhase != .active)) { context in
                    let phase = reduceMotion || still ? 0.45 :
                        context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 5) / 5
                    let leading = phase * 2.4 - 0.9
                    LinearGradient(stops: [
                        .init(color: .clear, location: 0),
                        .init(color: Theme.activity.opacity(0.24), location: 0.30),
                        .init(color: Theme.activity.opacity(0.70), location: 0.50),
                        .init(color: Theme.activity.opacity(0.24), location: 0.70),
                        .init(color: .clear, location: 1),
                    ], startPoint: UnitPoint(x: leading, y: 0.5),
                       endPoint: UnitPoint(x: leading + 0.9, y: 0.5))
                    .mask(content)
                    .shadow(color: Theme.activity.opacity(0.35), radius: 2)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        } else { content }
    }
}

extension View {
    func runningTextLight(_ active: Bool, still: Bool = false) -> some View {
        modifier(RunningTextLight(active: active, still: still))
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
