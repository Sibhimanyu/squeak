import SwiftUI

/// An abstract processing matrix: falling cell heads, fading wakes and a crossing current.
/// No characters, text, images or per-cell views. Both apps use this exact renderer.
public struct MatrixActivity: View {
    /// Compact marks and indicators share the same cell size; fields fill their available space.
    public enum Style: Sendable { case field, indicator, mark }
    private let style: Style
    private let color: Color
    private let quiet: Bool
    private let still: Bool
    private let identity: String?
    @State private var instanceIdentity = UUID().uuidString
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Every glyph is driven by the one system display link `TimelineView(.animation)` shares per window; it is paused
    /// here too whenever the window is not the active scene, so a background window burns no frames.
    @Environment(\.scenePhase) private var scenePhase

    public init(style: Style, color: Color, quiet: Bool = false, still: Bool = false, identity: String? = nil) {
        self.style = style; self.color = color; self.quiet = quiet; self.still = still
        self.identity = identity
    }

    public var body: some View {
        let motion = MatrixMotion(identity: identity ?? instanceIdentity)
        let frozen = reduceMotion || still || scenePhase != .active
        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: frozen)) { context in
            let arrival = motion.arrival(at: context.date.timeIntervalSinceReferenceDate, still: frozen)
            Canvas { graphics, size in
                guard size.width > 0, size.height > 0 else { return }
                let field = style == .field
                let columns = field ? max(1, min(120, Int(ceil(size.width / 6)))) : max(1, min(30, Int(size.width / 4)))
                let rows = field ? max(3, min(12, Int(ceil(size.height / 6)))) : max(1, min(10, Int(size.height / 4)))
                let pitchX = field ? size.width / CGFloat(columns) : min(4, size.width)
                let pitchY = field ? size.height / CGFloat(rows) : min(4, size.height)
                let originX = (size.width - CGFloat(columns) * pitchX) / 2
                let originY = (size.height - CGFloat(rows) * pitchY) / 2
                let side = min(pitchX, pitchY) * (field ? 0.52 : 0.60)
                let time = motion.patternTime(at: context.date.timeIntervalSinceReferenceDate * (quiet ? 0.55 : 1),
                                              still: frozen)
                for column in 0..<columns {
                    let seed = abs(sin(Double(column + 1) * 12.9898 + motion.seed * 63.7) * 43758.5453).truncatingRemainder(dividingBy: 1)
                    let travel = Double(rows) + 6
                    let head = (time * (3 + seed * 2) + seed * travel).truncatingRemainder(dividingBy: travel) - 2
                    for row in 0..<rows {
                        let distance = head - Double(row)
                        let wake = distance >= 0 && distance < 4 ? pow(1 - distance / 4, 1.4) : 0
                        let spark = max(0, 1 - abs(distance) * 1.8)
                        let current = max(0, sin(Double(column) * 0.72 + Double(row) * 0.88 - time * 2)) * 0.55
                        let energy = pow(max(spark, max(wake, current)), 0.65)
                        let peak = field ? 0.48 : (quiet ? 0.85 : 1.0)
                        // Fade the cells themselves, rather than blurring or clipping a rectangular grid.
                        // There is no inactive-cell floor: the empty lattice must never reveal a box.
                        let x = (Double(column) + 0.5) / Double(columns) * 2 - 1
                        let y = (Double(row) + 0.5) / Double(rows) * 2 - 1
                        let radius = sqrt(x * x + y * y)
                        let fade = max(0, min(1, (1 - radius) / 0.72))
                        let vignette = fade * fade * (3 - 2 * fade)
                        let opacity = peak * energy * vignette * (0.78 + 0.22 * arrival)
                        guard opacity > 0.002 else { continue }
                        let rect = CGRect(x: originX + (CGFloat(column) + 0.5) * pitchX - side / 2,
                                          y: originY + (CGFloat(row) + 0.5) * pitchY - side / 2, width: side, height: side)
                        graphics.fill(Path(roundedRect: rect, cornerRadius: side * 0.16),
                                      with: .color(color.opacity(opacity)))
                    }
                }
            }
            .shadow(color: color.opacity(arrival * 0.3), radius: 2)
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}
