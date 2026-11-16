import SwiftUI

/// The standard "work in motion" glyph: a small wave stream of square pixels, wider than tall, flowing left to right
/// with its ends dissolving. It always means working; the non-moving states are `StatusMark`. The caller passes the
/// colour (SqueakIcons has no Theme). `still` or Reduce Motion holds one frame.
public struct TideGlyph: View {
    /// The one cell pitch (dot plus gap, in points) of every tide glyph on a platform: the Mac's 1.5 pt is a 1 pt dot and a
    /// 0.5 pt gap; the phone's 2 pt is a 1.33 pt dot and a 0.67 pt gap. A glyph's size is `cols x pitch` by `rows x pitch`
    /// (less one trailing gap), so two glyphs on one screen always have pixels of the same size. A call site picks a
    /// grid (columns and rows) that fits its slot and never a scale. DESIGN.md §8.1, "Tide glyph pitch".
    #if os(macOS)
    public static let pitch: CGFloat = 1.5
    #else
    public static let pitch: CGFloat = 2
    #endif
    /// The gap is a third of the pitch, the dot the other two thirds.
    public static var gap: CGFloat { pitch / 3 }

    public struct Grid: Sendable, Equatable {
        public var cols: Int, rows: Int, gap: CGFloat
        /// Any gap, for the dev preview tools; shipped glyphs use `standard` (the global pitch).
        public init(cols: Int, rows: Int, gap: CGFloat) { self.cols = max(1, cols); self.rows = max(1, rows); self.gap = max(0, gap) }
        /// A grid at the platform's one cell pitch.
        public static func standard(cols: Int, rows: Int) -> Grid { Grid(cols: cols, rows: rows, gap: TideGlyph.gap) }
        /// The widest grid of `rows` rows that fits `width` points (at least 3 columns).
        public static func fitting(width: CGFloat, rows: Int) -> Grid { .standard(cols: max(3, Int(((width + TideGlyph.gap) / TideGlyph.pitch).rounded(.down))), rows: rows) }
        /// 7x3: a dot beside tight text.
        public static var micro: Grid { .standard(cols: 7, rows: 3) }
        /// 11x4: a button, a busy row, a stream slot (Mac 16.5 x 5.5, phone 22 x 7.3).
        public static var mini: Grid { .standard(cols: 11, rows: 4) }
        /// 11x5: a phone button (22 x 9.3).
        public static var medium: Grid { .standard(cols: 11, rows: 5) }
        /// 16x7: a Mac mark beside a title, 24 x 10.
        public static var compact: Grid { .standard(cols: 16, rows: 7) }
        /// 21x6: a row's working mark (Mac 31.5 x 8.5, phone 42 x 11.3).
        public static var mark: Grid { .standard(cols: 21, rows: 6) }
        /// 33x9: the Mac's working line (49.5 x 13).
        public static var stream: Grid { .standard(cols: 33, rows: 9) }
        public static var large: Grid { .standard(cols: 29, rows: 9) }
        /// Preview tools only: a named grid by height.
        public static func preset(forHeight h: CGFloat) -> Grid { h < 6 ? .micro : h <= 12 ? .mini : h <= 20 ? .mark : .large }

        /// The pixel side that makes `rows` rows fill `height`.
        public func side(height: CGFloat) -> CGFloat { (height - gap * CGFloat(rows - 1)) / CGFloat(rows) }
        /// The height whose glyph is `width` wide.
        public func height(fittingWidth width: CGFloat) -> CGFloat {
            let side = (width - gap * CGFloat(cols - 1)) / CGFloat(cols)
            return side * CGFloat(rows) + gap * CGFloat(rows - 1)
        }
        /// The glyph's width at `height`: the width follows the grid's aspect, so pixels stay square.
        public func width(height: CGFloat) -> CGFloat { side(height: height) * CGFloat(cols) + gap * CGFloat(cols - 1) }
        /// One cell's pitch (pixel plus gap) when the grid is drawn at `height`.
        public func pitch(height: CGFloat) -> CGFloat { side(height: height) + gap }
        /// The pixel side at the global pitch.
        public var side: CGFloat { TideGlyph.pitch - gap }
        /// The drawn size at the global pitch: `cols x pitch` by `rows x pitch`, less the trailing gap.
        public var size: CGSize { CGSize(width: CGFloat(cols) * (side + gap) - gap, height: CGFloat(rows) * (side + gap) - gap) }
    }

    private let color: Color, still: Bool, grid: Grid, fixedSeed: UInt64?, fade: Bool, tuning: TideMotion.Tuning
    /// One random seed per view, captured once: two glyphs side by side never match.
    @State private var instanceSeed = UInt64.random(in: .min ... .max)
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Paused only in `.background`: macOS reports `.inactive` whenever the app is not frontmost, and a status glyph
    /// must keep moving while the person works in another app.
    @Environment(\.scenePhase) private var scenePhase

    /// `fade` multiplies every pixel by a soft elliptical vignette (default on) so the glyph never reads as a box. To draw
    /// it past its layout slot, give it a bigger grid and a smaller frame (`.frame(width: slot, alignment:)`): SwiftUI
    /// centres or aligns the overflow without clipping, and the glyph never takes hits. Its size is the grid's, at the one pitch.
    public init(color: Color, grid: Grid, still: Bool = false, seed: UInt64? = nil, fade: Bool = true, tuning: TideMotion.Tuning = TideMotion.Tuning()) {
        self.tuning = tuning; self.color = color; self.still = still; self.fixedSeed = seed; self.fade = fade
        self.grid = grid
    }

    public var body: some View {
        let seed = fixedSeed ?? instanceSeed
        return Group {
            if !still && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / Double(max(1, tuning.frameRate)), paused: scenePhase == .background)) { context in
                    TideFrame(color: color, height: grid.size.height, grid: grid, time: TideMotion.clock(context.date), seed: seed, fade: fade, tuning: tuning)
                }
            } else {
                TideFrame(color: color, height: grid.size.height, grid: grid, time: nil, seed: seed, fade: fade, tuning: tuning)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// One frame of the glyph at an explicit time (nil = the still frame); the preview drives it directly.
public struct TideFrame: View {
    let color: Color, height: CGFloat, grid: TideGlyph.Grid, time: Double?, seed: UInt64, fade: Bool, tuning: TideMotion.Tuning

    public init(color: Color, height: CGFloat, grid: TideGlyph.Grid? = nil, time: Double?, seed: UInt64 = 0, fade: Bool = true, tuning: TideMotion.Tuning = TideMotion.Tuning()) {
        self.tuning = tuning; self.color = color; self.height = height; self.grid = grid ?? .preset(forHeight: height); self.time = time; self.seed = seed; self.fade = fade
    }

    public var body: some View {
        Canvas { graphics, canvas in
            Self.draw(&graphics, size: canvas, color: color, grid: grid, time: time, seed: seed, fade: fade, tuning: tuning)
        }
        .frame(width: grid.width(height: height), height: height)
    }

    public static func draw(_ graphics: inout GraphicsContext, size: CGSize, color: Color, grid: TideGlyph.Grid, time: Double?, seed: UInt64 = 0, fade: Bool = true, tuning: TideMotion.Tuning = TideMotion.Tuning()) {
        let side = grid.side(height: size.height)
        guard side > 0 else { return }
        let ox = (size.width - grid.width(height: size.height)) / 2
        // The pixels are drawn at full strength; the vignette is one smooth elliptical mask over the whole glyph, so an
        // edge square shades across its own area (brighter inside, dimmer outside) instead of being in or out whole.
        graphics.drawLayer { layer in
            for row in 0..<grid.rows {
                for col in 0..<grid.cols {
                    let a: Double
                    if let time { a = TideMotion.smoothAlpha(col: col, row: row, cols: grid.cols, rows: grid.rows, t: time, seed: seed, tuning: tuning) }
                    else { a = TideMotion.alpha(TideMotion.stillLevel(col: col, row: row, cols: grid.cols, rows: grid.rows, seed: seed)) }
                    guard a > 0.004 else { continue }
                    let rect = CGRect(x: ox + CGFloat(col) * (side + grid.gap), y: CGFloat(row) * (side + grid.gap), width: side, height: side)
                    layer.fill(Path(rect), with: .color(color.opacity(a)))
                }
            }
            guard fade else { return }
            let w = grid.width(height: size.height)
            let stops = (0...24).map { k -> Gradient.Stop in
                let r = Double(k) / 24
                return Gradient.Stop(color: .black.opacity(TideMotion.vignetteCurve(r: r, tuning: tuning)), location: r)
            }
            layer.blendMode = .destinationIn
            layer.translateBy(x: ox + w / 2, y: size.height / 2)
            layer.scaleBy(x: w / 2, y: size.height / 1.1)  // unit space: u = x / half width, v = 0.55 * y / half height
            layer.fill(Path(CGRect(x: -3, y: -3, width: 6, height: 6)),
                       with: .radialGradient(Gradient(stops: stops), center: .zero, startRadius: 0, endRadius: 1))
        }
    }
}
