import SqueakMacCore
import SwiftUI

/// A stream's icon (DESIGN.md §8.1, "Stream glyph"): a 3 x 6 grid of dots on three gentle wave lines, drawn in the
/// dot-grid loader's language. idle is `muted`, dim and still; working sends a soft brightness wave left to right in
/// `working` (`StreamDotGlyph`, 1.6 s a pass); waiting is steady `warning`; failed steady `negative`; unread steady
/// `done`. The state comes from the daemon's data (`StreamGlyphState`); this only draws it.
///
/// Cost: only a working glyph owns a `TimelineView` (20 ticks a second at most); every other state is one static
/// `Canvas`. SwiftUI stops a timeline while its window is hidden or occluded, a row scrolled out of its lazy stack is
/// not built, and Reduce Motion or an inactive window holds one frame of the wave. The phase is the wall clock's, so
/// glyphs flow in step with no shared object. The footprint is the old icon's: `size` square.
struct StreamGlyph: View {
    let state: StreamGlyphState
    var size: CGFloat = 15
    /// The stream's name; when given the glyph speaks "name, working", otherwise it is decoration.
    var name: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var colour: Color {
        switch state {
        case .idle: Theme.muted
        case .working: Theme.working
        case .waiting: Theme.warning
        case .failed: Theme.negative
        case .unread: Theme.done
        }
    }

    var body: some View {
        Group {
            if StreamDotGlyph.flows(state), !reduceMotion, scenePhase == .active {
                TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 1 / StreamDotGlyph.framesPerSecond)) { ctx in
                    dots(time: ctx.date.timeIntervalSinceReferenceDate, animated: true)
                }
            } else {
                dots(time: 0, animated: false)
            }
        }
        .frame(width: size, height: size)
        .modifier(StreamGlyphSpeech(name: name, state: state))
    }

    private func dots(time: TimeInterval, animated: Bool) -> some View {
        Canvas(rendersAsynchronously: false) { context, canvas in
            let side = min(canvas.width, canvas.height)
            let radius = side / CGFloat(StreamDotGlyph.columns) * 0.36
            for row in 0..<StreamDotGlyph.rows {
                for col in 0..<StreamDotGlyph.columns {
                    let c = StreamDotGlyph.centre(row: row, column: col)
                    let level = StreamDotGlyph.level(state: state, row: row, column: col, time: time, animated: animated)
                    let rect = CGRect(x: c.x * side - radius, y: c.y * side - radius, width: radius * 2, height: radius * 2)
                    context.fill(Path(ellipseIn: rect), with: .color(colour.opacity(level)))
                }
            }
        }
    }
}

private struct StreamGlyphSpeech: ViewModifier {
    let name: String?
    let state: StreamGlyphState

    func body(content: Content) -> some View {
        if let name {
            content.accessibilityElement().accessibilityLabel(state.label(for: name))
        } else {
            content.accessibilityHidden(true)
        }
    }
}
