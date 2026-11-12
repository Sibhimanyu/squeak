import SqueakIcons
import SqueakMacCore
import SwiftUI

/// A stream's icon: Lucide `waves` redrawn as three sine lines (same 24 grid, 1.5 pt round stroke) so it can move.
/// idle is `muted` and still; working flows in the working colour; waiting is amber with a small dot; failed is red;
/// unread is blue. The state comes from the daemon's data (`StreamGlyphState`); this only draws it.
///
/// Cost: only a working glyph owns a `TimelineView`, ticking 30 times a second at most; every other state is one
/// static `Canvas` with no timeline. SwiftUI stops a timeline while its window is hidden or occluded, a row scrolled
/// out of its lazy stack is not built, and Reduce Motion or an inactive window draws the still working colour. The
/// phase is the wall clock's (`StreamGlyphGeometry.phase`), so glyphs turn in step with no shared object.
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
            if state == .working, !reduceMotion, scenePhase == .active {
                TimelineView(.periodic(from: Date(timeIntervalSinceReferenceDate: 0), by: 1 / StreamGlyphGeometry.framesPerSecond)) { ctx in
                    waves(phase: StreamGlyphGeometry.phase(at: ctx.date.timeIntervalSinceReferenceDate))
                }
            } else {
                waves(phase: 0)
            }
        }
        .frame(width: size, height: size)
        .modifier(StreamGlyphSpeech(name: name, state: state))
    }

    private func waves(phase: Double) -> some View {
        Canvas(rendersAsynchronously: false) { context, canvas in
            let scale = min(canvas.width, canvas.height) / 24
            let style = StrokeStyle(lineWidth: Lucide.strokeWidth, lineCap: .round, lineJoin: .round)
            for row in StreamGlyphGeometry.rows.indices {
                var path = Path()
                for (i, p) in StreamGlyphGeometry.points(row: row, phase: phase).enumerated() {
                    let q = CGPoint(x: p.x * scale, y: p.y * scale)
                    if i == 0 { path.move(to: q) } else { path.addLine(to: q) }
                }
                context.stroke(path, with: .color(colour), style: style)
            }
            if state == .waiting {
                let r = 2.4 * scale
                context.fill(Path(ellipseIn: CGRect(x: 21 * scale - r, y: 3 * scale - r, width: 2 * r, height: 2 * r)), with: .color(colour))
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
