import SqueakMacCore
import SwiftUI

/// DESIGN.md §8.1: the one loader. A 3x3 grid of dots with a comet tail, `muted`, nine frames of 110 ms; the quiet
/// variant (a Conductor chat waiting on background tasks) is the same at 70% on a 3 s cycle. Drawn in one `Canvas`,
/// no images. The frame comes from the wall clock, so every loader on screen turns in step; the tick is a periodic
/// `TimelineView` (about 9 a second, no implicit animation) that SwiftUI pauses while the window is hidden or occluded,
/// and a row that is scrolled out of its lazy stack is not built at all. Reduce Motion draws frame 5 and no timeline.
struct DotGridLoader: View {
    var size: CGFloat = 12
    var quiet = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                grid(frame: DotGridFrames.heldFrame)
            } else {
                let step = quiet ? DotGridFrames.quietFrameSeconds : DotGridFrames.frameSeconds
                TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: step)) { ctx in
                    grid(frame: DotGridFrames.frame(at: ctx.date.timeIntervalSinceReferenceDate, quiet: quiet))
                }
            }
        }
        .frame(width: size, height: size)
        .opacity(quiet ? DotGridFrames.quietOpacity : 1)
        .foregroundStyle(Theme.muted)
        .accessibilityHidden(true)
    }

    private func grid(frame: Int) -> some View {
        Canvas(rendersAsynchronously: false) { context, canvasSize in
            let unit = min(canvasSize.width, canvasSize.height) / 14
            let r = DotGridFrames.radius * unit
            let opacities = DotGridFrames.opacities(frame: frame)
            for i in 0..<9 {
                let x = DotGridFrames.centres[i / 3] * unit, y = DotGridFrames.centres[i % 3] * unit
                var c = context
                c.opacity = opacities[i]
                c.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r)), with: .foreground)
            }
        }
        .frame(width: size, height: size)
    }
}
