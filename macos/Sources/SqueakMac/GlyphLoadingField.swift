import SwiftUI

/// A ghost of a moving command surface, clipped behind crisp tab titles. No text is taken from a chat.
/// Idle views don't instantiate this timeline. Reduce Motion keeps one quiet, static frame.
struct GlyphLoadingField: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 12, paused: reduceMotion)) { context in
            Canvas { graphics, size in
                let time = reduceMotion ? 0 : context.date.timeIntervalSinceReferenceDate
                let symbols = ["{", "/", "}", "·", "_", "⌁", ":", ">"]
                let advance = (time * 9).truncatingRemainder(dividingBy: 23)
                for row in 0..<3 {
                    for column in -1...Int(size.width / 23) + 1 {
                        let index = abs(column + row * 3) % symbols.count
                        let opacity = 0.08 + 0.10 * (0.5 + 0.5 * sin(time * 0.7 + Double(column + row)))
                        graphics.draw(Text(symbols[index]).font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Theme.muted.opacity(opacity)),
                            at: CGPoint(x: CGFloat(column) * 23 + advance, y: CGFloat(row) * 12 + 2))
                    }
                }
            }
        }
        .blur(radius: 0.6).clipped().allowsHitTesting(false).accessibilityHidden(true)
    }
}
