import SwiftUI

/// The standard "work in motion" glyph: a small wave stream of square pixels, wider than tall, flowing left to right
/// with its ends dissolving. It always means working; the non-moving states are `StatusMark`. The caller passes the
/// colour (SqueakIcons has no Theme). `still` or Reduce Motion holds one frame.
public struct TideGlyph: View {
    public struct Grid: Sendable, Equatable {
        public var cols: Int, rows: Int, gap: CGFloat
        public init(cols: Int, rows: Int, gap: CGFloat) { self.cols = max(1, cols); self.rows = max(1, rows); self.gap = max(0, gap) }
        /// 7×3 with no gap: pixels are height/3, so at least 1 pt from 3 pt tall.
        public static let micro = Grid(cols: 7, rows: 3, gap: 0)
        public static let mini = Grid(cols: 11, rows: 4, gap: 0.5)
        public static let mark = Grid(cols: 21, rows: 6, gap: 0.5)
        public static let large = Grid(cols: 29, rows: 9, gap: 0.5)
        /// Micro below 6 pt tall, mini up to 12 pt, mark up to 20 pt, large above. Each grid's pixel is at least 1 pt at
        /// every height it is chosen for (micro from 3 pt, mini from 5.5 pt, mark from 8.5 pt, large from 13 pt).
        public static func preset(forHeight h: CGFloat) -> Grid { h < 6 ? .micro : h <= 12 ? .mini : h <= 20 ? .mark : .large }

        /// The pixel side that makes `rows` rows fill `height`.
        public func side(height: CGFloat) -> CGFloat { (height - gap * CGFloat(rows - 1)) / CGFloat(rows) }
        /// The height whose glyph is `width` wide: how a call site fits a slot by its width.
        public func height(fittingWidth width: CGFloat) -> CGFloat {
            let side = (width - gap * CGFloat(cols - 1)) / CGFloat(cols)
            return side * CGFloat(rows) + gap * CGFloat(rows - 1)
        }
        /// The glyph's width at `height`: the width follows the grid's aspect, so pixels stay square.
        public func width(height: CGFloat) -> CGFloat { side(height: height) * CGFloat(cols) + gap * CGFloat(cols - 1) }
    }

    private let color: Color, height: CGFloat, still: Bool, grid: Grid, fixedSeed: UInt64?, fade: Bool
    /// One random seed per view, captured once: two glyphs side by side never match.
    @State private var instanceSeed = UInt64.random(in: .min ... .max)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// `fade` multiplies every pixel by a soft elliptical vignette (default on) so the glyph never reads as a box. To draw
    /// it larger than its layout slot, give it a taller `height` and a smaller frame (`.frame(width: slot, alignment:)`):
    /// SwiftUI centres or aligns the overflow without clipping, and the glyph never takes hits.
    public init(color: Color, height: CGFloat, still: Bool = false, grid: Grid? = nil, seed: UInt64? = nil, fade: Bool = true) {
        self.color = color; self.height = height; self.still = still; self.fixedSeed = seed; self.fade = fade
        self.grid = grid ?? .preset(forHeight: height)
    }

    public var body: some View {
        let seed = fixedSeed ?? instanceSeed
        return Group {
            if !still && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / 15, paused: scenePhase != .active)) { context in
                    TideFrame(color: color, height: height, grid: grid, time: context.date.timeIntervalSinceReferenceDate, seed: seed, fade: fade)
                }
            } else {
                TideFrame(color: color, height: height, grid: grid, time: nil, seed: seed, fade: fade)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// One frame of the glyph at an explicit time (nil = the still frame); the preview drives it directly.
public struct TideFrame: View {
    let color: Color, height: CGFloat, grid: TideGlyph.Grid, time: Double?, seed: UInt64, fade: Bool

    public init(color: Color, height: CGFloat, grid: TideGlyph.Grid? = nil, time: Double?, seed: UInt64 = 0, fade: Bool = true) {
        self.color = color; self.height = height; self.grid = grid ?? .preset(forHeight: height); self.time = time; self.seed = seed; self.fade = fade
    }

    public var body: some View {
        Canvas { graphics, canvas in
            Self.draw(&graphics, size: canvas, color: color, grid: grid, time: time, seed: seed, fade: fade)
        }
        .frame(width: grid.width(height: height), height: height)
    }

    public static func draw(_ graphics: inout GraphicsContext, size: CGSize, color: Color, grid: TideGlyph.Grid, time: Double?, seed: UInt64 = 0, fade: Bool = true) {
        let side = grid.side(height: size.height)
        guard side > 0 else { return }
        let ox = (size.width - grid.width(height: size.height)) / 2
        for row in 0..<grid.rows {
            for col in 0..<grid.cols {
                let level = time.map { TideMotion.level(col: col, row: row, cols: grid.cols, rows: grid.rows, t: $0, seed: seed) }
                    ?? TideMotion.stillLevel(col: col, row: row, cols: grid.cols, rows: grid.rows, seed: seed)
                guard level > 0 else { continue }
                let rect = CGRect(x: ox + CGFloat(col) * (side + grid.gap), y: CGFloat(row) * (side + grid.gap),
                                  width: side, height: side)
                graphics.fill(Path(rect), with: .color(color.opacity(TideMotion.alpha(level) * (fade ? TideMotion.vignette(col: col, row: row, cols: grid.cols, rows: grid.rows) : 1))))
            }
        }
    }
}
