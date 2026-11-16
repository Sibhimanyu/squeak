import SwiftUI

/// The standard "work in motion" glyph: a small block of square pixels, wider than tall, twinkling at random
/// and fading out toward every edge. It always means working; the non-moving states are `StatusMark`. The caller passes the
/// colour (SqueakIcons has no Theme). `still` or Reduce Motion holds one frame.
public struct TideGlyph: View {
    /// The one cell pitch (dot plus gap, in points) of every tide glyph on a platform: the Mac's 3 pt is a 2.25 pt dot and a
    /// 0.75 pt gap; the phone's 3.5 pt is a 2.625 pt dot and a 0.875 pt gap. Chunky on purpose (owner, 2026-11-16: fine
    /// dots read as noise); drawn dot edges snap to whole device pixels so each is a crisp square. A glyph's size is `cols x pitch` by `rows x pitch`
    /// (less one trailing gap), so two glyphs on one screen always have pixels of the same size. A call site picks a
    /// grid (columns and rows) that fits its slot and never a scale. DESIGN.md §8.1, "Tide glyph pitch".
    #if os(macOS)
    public static let pitch: CGFloat = 3
    #else
    public static let pitch: CGFloat = 3.5
    #endif
    /// The gap is a quarter of the pitch, the dot the other three quarters.
    public static var gap: CGFloat { pitch / 4 }

    public struct Grid: Sendable, Equatable {
        public var cols: Int, rows: Int, gap: CGFloat
        /// Any gap, for the dev preview tools; shipped glyphs use `standard` (the global pitch).
        public init(cols: Int, rows: Int, gap: CGFloat) { self.cols = max(1, cols); self.rows = max(1, rows); self.gap = max(0, gap) }
        /// A grid at the platform's one cell pitch.
        public static func standard(cols: Int, rows: Int) -> Grid { Grid(cols: cols, rows: rows, gap: TideGlyph.gap) }
        /// The widest grid of `rows` rows that fits `width` points (at least 3 columns).
        public static func fitting(width: CGFloat, rows: Int) -> Grid { .standard(cols: max(3, Int(((width + TideGlyph.gap) / TideGlyph.pitch).rounded(.down))), rows: rows) }
        /// 4x2: a dot beside tight text (Mac 11.25 x 5.25).
        public static var micro: Grid { .standard(cols: 4, rows: 2) }
        /// 6x3: a button, a busy row, a stream slot (Mac 17.25 x 8.25, phone 20.1 x 9.6).
        public static var mini: Grid { .standard(cols: 6, rows: 3) }
        /// 7x3: a phone button (23.6 x 9.6).
        public static var medium: Grid { .standard(cols: 7, rows: 3) }
        /// 7x4: a Mac mark beside a title, 20.25 x 11.25.
        public static var compact: Grid { .standard(cols: 7, rows: 4) }
        /// 10x4: a row's working mark (Mac 29.25 x 11.25, phone 34.1 x 13.1).
        public static var mark: Grid { .standard(cols: 10, rows: 4) }
        /// 16x5: the Mac's working line (47.25 x 14.25).
        public static var stream: Grid { .standard(cols: 16, rows: 5) }
        public static var large: Grid { .standard(cols: 14, rows: 5) }
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
    private var calm = false
    @Environment(\.displayScale) private var displayScale
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

    /// The calm mark for a stream that is not working: one frozen frame of the same glyph on the same grid, so idle to
    /// working only starts the motion and changes colour. A fixed pure frame (`TideMotion.calmLevel`),
    /// no TimelineView, so it is identical everywhere and costs nothing. DESIGN.md §8.1, "Idle stream mark".
    public static func calm(color: Color, grid: Grid) -> TideGlyph {
        var glyph = TideGlyph(color: color, grid: grid, still: true, seed: TideMotion.calmSeed)
        glyph.calm = true
        return glyph
    }

    public var body: some View {
        let seed = fixedSeed ?? instanceSeed
        return Group {
            if !still && !reduceMotion {
                TimelineView(.animation(minimumInterval: 1.0 / Double(max(1, tuning.frameRate)), paused: scenePhase == .background)) { context in
                    TideFrame(color: color, height: grid.size.height, grid: grid, time: TideMotion.clock(context.date), seed: seed, fade: fade, tuning: tuning, scale: displayScale)
                }
            } else {
                TideFrame(color: color, height: grid.size.height, grid: grid, time: nil, seed: seed, fade: fade, tuning: tuning, scale: displayScale, calm: calm)
            }
        }
        .allowsHitTesting(false).accessibilityHidden(true)
    }
}

/// One frame of the glyph at an explicit time (nil = the still frame); the preview drives it directly.
public struct TideFrame: View {
    let color: Color, height: CGFloat, grid: TideGlyph.Grid, time: Double?, seed: UInt64, fade: Bool, tuning: TideMotion.Tuning, scale: CGFloat, calm: Bool

    public init(color: Color, height: CGFloat, grid: TideGlyph.Grid? = nil, time: Double?, seed: UInt64 = 0, fade: Bool = true, tuning: TideMotion.Tuning = TideMotion.Tuning(), scale: CGFloat = 2, calm: Bool = false) {
        self.calm = calm; self.scale = scale; self.tuning = tuning; self.color = color; self.height = height; self.grid = grid ?? .preset(forHeight: height); self.time = time; self.seed = seed; self.fade = fade
    }

    public var body: some View {
        Canvas { graphics, canvas in
            Self.draw(&graphics, size: canvas, color: color, grid: grid, time: time, seed: seed, fade: fade, tuning: tuning, scale: scale, calm: calm)
        }
        .frame(width: grid.width(height: height), height: height)
    }

    public static func draw(_ graphics: inout GraphicsContext, size: CGSize, color: Color, grid: TideGlyph.Grid, time: Double?, seed: UInt64 = 0, fade: Bool = true, tuning: TideMotion.Tuning = TideMotion.Tuning(), scale: CGFloat = 2, calm: Bool = false) {
        let side = grid.side(height: size.height)
        guard side > 0 else { return }
        let ox = (size.width - grid.width(height: size.height)) / 2
        // The radial fade is per cell, inside `TideMotion` (a partial alpha per cell, corners darkest); `fade` off turns it off.
        var tuning = tuning
        if !fade { tuning.vignette = 0 }
        graphics.drawLayer { layer in
            for row in 0..<grid.rows {
                for col in 0..<grid.cols {
                    let a: Double
                    if calm { a = TideMotion.calmAlpha(col: col, row: row, cols: grid.cols, rows: grid.rows) }
                    else if let time { a = TideMotion.smoothAlpha(col: col, row: row, cols: grid.cols, rows: grid.rows, t: time, seed: seed, tuning: tuning) }
                    else { a = TideMotion.alpha(TideMotion.level(col: col, row: row, cols: grid.cols, rows: grid.rows, t: TideMotion.stillTime, seed: seed, tuning: tuning)) }
                    guard a > 0.004 else { continue }
                    // Edges snap to whole device pixels so every dot is a crisp square.
                    func snap(_ v: CGFloat) -> CGFloat { (v * scale).rounded() / scale }
                    let x0 = snap(ox + CGFloat(col) * (side + grid.gap)), y0 = snap(CGFloat(row) * (side + grid.gap))
                    let rect = CGRect(x: x0, y: y0, width: snap(ox + CGFloat(col) * (side + grid.gap) + side) - x0, height: snap(CGFloat(row) * (side + grid.gap) + side) - y0)
                    layer.fill(Path(rect), with: .color(color.opacity(a)))
                }
            }
        }
    }
}
