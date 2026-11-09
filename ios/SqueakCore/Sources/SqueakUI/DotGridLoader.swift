#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// The working mark (marks-v3, loader A): a 3x3 grid of dots with a comet running through it, 9 frames of 110 ms,
/// in `muted`. `quiet` is the background-waiting variant: 70% opacity on a 3 s cycle. Reduce Motion holds frame 5.
///
/// Cheap on purpose: one `Canvas`, no per-dot views, and the frame is read from a fixed epoch so every loader on
/// screen shares one clock and stays in step. A `TimelineView` only ticks while its view is on screen (lazy rows
/// that scroll away are gone), and it is not scheduled at all under Reduce Motion.
struct DotGridLoader: View {
    var size: CGFloat = 14
    var quiet = false
    var color: Color = Theme.muted
    /// Held on frame 5 whatever the setting (the Mac has stopped answering).
    var still = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private typealias G = DotGrid

    var body: some View {
        Group {
            if reduceMotion || still {
                grid(frame: G.heldFrame)
            } else {
                let period = (quiet ? G.quietCycle : G.cycle) / Double(G.frames)
                TimelineView(.periodic(from: G.epoch, by: period)) { context in
                    grid(frame: G.frame(at: context.date, quiet: quiet))
                }
            }
        }
        .frame(width: size, height: size)
        .opacity(quiet ? 0.7 : 1)
        .accessibilityHidden(true)
    }

    private func grid(frame: Int) -> some View {
        Canvas { context, canvas in
            let cell = canvas.width / 3
            let radius = cell * 0.26
            for dot in 0..<9 {
                let col = dot / 3, row = dot % 3
                let center = CGPoint(x: (CGFloat(col) + 0.5) * cell, y: (CGFloat(row) + 0.5) * cell)
                let rect = CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
                context.fill(Path(ellipseIn: rect), with: .color(color.opacity(G.level(dot: dot, frame: frame))))
            }
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
