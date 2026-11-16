#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A trailing activity mark for a working row: the tide glyph (mark grid), still while the Mac is not answering. It
/// never takes the agent's icon slot or paints behind the title.
struct ChatActivityGlyph: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TideGlyph(color: model.macIsLive ? Theme.working : Theme.subtle, grid: .mark, still: !model.macIsLive)
    }
}

/// A passing pool of light picks out the letters and casts a small halo, keeping the base text readable.
private struct RunningTextLight: ViewModifier {
    let active: Bool
    let still: Bool
    let identity: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// One pass of light every 4.2 to 6 seconds, offset per chat so two rows never pulse together; a held frame when still.
    static func phase(identity: String, at time: TimeInterval, still: Bool) -> Double {
        guard !still else { return 0.48 }
        let key = identity.utf8.reduce(UInt32(2166136261)) { ($0 ^ UInt32($1)) &* 16777619 }
        let period = 4.2 + Double(key & 0xFFFF) / 65535 * 1.8
        let offset = Double((key >> 16) & 0xFFFF) / 65535 * period
        let value = (time + offset) / period
        return value - floor(value)
    }

    func body(content: Content) -> some View {
        if active {
            content.opacity(0.84).overlay {
                TimelineView(.animation(minimumInterval: 1.0 / 15,
                                        paused: reduceMotion || still || scenePhase != .active)) { context in
                    let phase = Self.phase(identity: identity, at: context.date.timeIntervalSinceReferenceDate,
                                           still: reduceMotion || still)
                    let leading = phase * 2 - 0.8
                    LinearGradient(stops: [
                        .init(color: .clear, location: 0),
                        .init(color: Theme.activity.opacity(0.45), location: 0.25),
                        .init(color: Theme.activity, location: 0.50),
                        .init(color: Theme.activity.opacity(0.45), location: 0.75),
                        .init(color: .clear, location: 1),
                    ], startPoint: UnitPoint(x: leading, y: 0.5),
                       endPoint: UnitPoint(x: leading + 0.9, y: 0.5))
                    .mask(content)
                    .shadow(color: Theme.activity.opacity(0.75), radius: 4)
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        } else { content }
    }
}

extension View {
    func runningTextLight(_ active: Bool, identity: String, still: Bool = false) -> some View {
        modifier(RunningTextLight(active: active, still: still, identity: identity))
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
