#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A stream's icon (DESIGN.md §8.1, "Stream glyph"): a 3 x 6 grid of dots on three gentle wave lines. idle: still, dim,
/// `muted`. working: a soft brightness wave runs left to right in `working` (`StreamDotGlyph`, 1.6 s a pass). needs you:
/// steady `warning`. error: steady `negative`. The state is the Mac's rollup (`StatusRollup`); this only draws it.
/// Only a working glyph owns a `TimelineView`; Reduce Motion, or a Mac that is not answering, holds one frame of the wave.
/// The footprint is the old icon's, 24 pt wide, so rows never shift.
struct StreamGlyph: View {
    let activity: StatusRollup.Activity
    var size: CGFloat = 22
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(AppModel.self) private var model

    private var colour: Color {
        switch activity {
        case .idle: Theme.muted
        case .working: Theme.working
        case .needsYou: Theme.warning
        case .error: Theme.negative
        }
    }

    var body: some View {
        Group {
            if StreamDotGlyph.flows(activity), !reduceMotion, model.macIsLive {
                TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 1 / StreamDotGlyph.framesPerSecond)) { ctx in
                    dots(time: ctx.date.timeIntervalSinceReferenceDate, animated: true)
                }
            } else {
                dots(time: 0, animated: false)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func dots(time: TimeInterval, animated: Bool) -> some View {
        Canvas(rendersAsynchronously: false) { context, canvas in
            let side = min(canvas.width, canvas.height)
            let radius = side / CGFloat(StreamDotGlyph.columns) * 0.36
            for row in 0..<StreamDotGlyph.rows {
                for col in 0..<StreamDotGlyph.columns {
                    let c = StreamDotGlyph.centre(row: row, column: col)
                    let level = StreamDotGlyph.level(activity, row: row, column: col, time: time, animated: animated)
                    context.fill(Path(ellipseIn: CGRect(x: c.x * side - radius, y: c.y * side - radius, width: radius * 2, height: radius * 2)),
                                 with: .color(colour.opacity(level)))
                }
            }
        }
    }
}

/// A pond row's trailing mark, in one fixed 34 x 20 slot so the row never changes size: needs-you count wins, then the
/// working matrix, then the error mark; idle draws nothing.
struct PondStatusMark: View {
    let rollup: StatusRollup
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch rollup.mark {
            case .needsYou(let n): CountBadge(count: n)
            case .working:
                MatrixActivity(style: .indicator, color: Theme.working, still: reduceMotion || !model.macIsLive)
            case .error:
                Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.negative)
            case nil: Color.clear
            }
        }
        .frame(width: 34, height: 20, alignment: .trailing)
        .accessibilityHidden(true)
    }
}
#endif
