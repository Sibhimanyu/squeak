import AppKit
import PDFKit
import SqueakMacCore
import SwiftUI

// The artifact canvas: an Adobe-like unlimited pasteboard for Illustrator files, one-page PDFs, SVG and pictures.
// Artboards are white pages with a soft shadow, side by side with their names; vector art is redrawn at the current
// scale by a tiled layer on background threads (crisp at any zoom). A gesture previews by scaling the last drawn layer
// and the crisp redraw follows when it settles, so pinch and pan never wait on rendering.

/// One artboard: its size on the pasteboard and what draws it.
struct CanvasBoard: @unchecked Sendable {
    enum Art { case pdf(CGPDFPage, PDFDocument), image(NSImage) }
    let name: String
    let size: CGSize
    let art: Art

    /// Every page of a PDF as a board (a PDF's pages, or an `.ai` file's artboards).
    static func boards(of document: PDFDocument, names: [String]? = nil) -> [CanvasBoard] {
        (0..<document.pageCount).compactMap { i in
            guard let page = document.page(at: i), let ref = page.pageRef else { return nil }
            let r = page.bounds(for: .cropBox)
            guard r.width > 0, r.height > 0 else { return nil }
            let label = names.flatMap { i < $0.count ? $0[i] : nil }
            return CanvasBoard(name: ArtboardLayout.label(name: label, index: i), size: r.size, art: .pdf(ref, document))
        }
    }

    static func board(image: NSImage, pixels: CGSize, name: String) -> CanvasBoard {
        let s = pixels.width > 0 ? pixels : image.size
        return CanvasBoard(name: name, size: s, art: .image(image))
    }
}

/// What the viewer's single toolbar row needs from whichever viewer is showing.
@MainActor protocol ViewerControlling: AnyObject {
    /// (zero-based page or artboard, count) — the row shows the switcher only for more than one.
    var switcher: (index: Int, count: Int)? { get }
    var zoomLevel: Double? { get }
    func step(_ by: Int)
    func zoomStep(in zoomIn: Bool)
    func fit()
}

@MainActor @Observable
final class CanvasController: ViewerControlling {
    let boards: [CanvasBoard]
    let frames: [CGRect]
    private(set) var index = 0
    private(set) var zoomValue = 1.0
    @ObservationIgnored let view: CanvasNSView

    var switcher: (index: Int, count: Int)? { (index, boards.count) }
    var zoomLevel: Double? { zoomValue }

    init(boards: [CanvasBoard]) {
        self.boards = boards
        frames = ArtboardLayout.place(boards.map(\.size))
        view = CanvasNSView(boards: boards, frames: frames)
        view.onChange = { [weak self] zoom, nearest in
            guard let self else { return }
            if zoom != zoomValue { zoomValue = zoom }
            if let nearest, nearest != index { index = nearest }
        }
    }

    func step(_ by: Int) {
        let next = ArtifactSwitcher.stepped(index, by: by, count: boards.count)
        index = next
        view.show(frames[next])
    }
    func zoomStep(in zoomIn: Bool) { view.zoomStep(in: zoomIn) }
    func fit() { view.show(ArtboardLayout.bounds(frames)) }
}

struct ArtifactCanvasViewer: View {
    let controller: CanvasController
    var body: some View { CanvasHost(view: controller.view) }
}

private struct CanvasHost: NSViewRepresentable {
    let view: CanvasNSView
    func makeNSView(context: Context) -> CanvasNSView { view }
    func updateNSView(_ v: CanvasNSView, context: Context) {}
}

/// Draws the boards on a CATiledLayer from background threads.
private final class CanvasRenderer: NSObject, CALayerDelegate, @unchecked Sendable {
    struct Snapshot { var viewport: CanvasViewport; var height: Double }
    private let lock = NSLock()
    private let pdfLock = NSLock()
    private var snapshot = Snapshot(viewport: CanvasViewport(), height: 0)
    let boards: [CanvasBoard]
    let frames: [CGRect]

    init(boards: [CanvasBoard], frames: [CGRect]) { self.boards = boards; self.frames = frames }

    func set(_ s: Snapshot) { lock.lock(); snapshot = s; lock.unlock() }
    private func current() -> Snapshot { lock.lock(); defer { lock.unlock() }; return snapshot }

    func draw(_ layer: CALayer, in ctx: CGContext) {
        let s = current()
        let z = s.viewport.zoom
        let clip = ctx.boundingBoxOfClipPath
        for (i, board) in boards.enumerated() {
            // Layer space is y-up; world and viewport are y-down.
            let f = frames[i]
            let rect = CGRect(
                x: (f.minX - s.viewport.origin.x) * z, y: s.height - (f.maxY - s.viewport.origin.y) * z,
                width: f.width * z, height: f.height * z)
            guard rect.insetBy(dx: -40, dy: -40).intersects(clip) else { continue }
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -3), blur: 14, color: CGColor(gray: 0, alpha: 0.45))
            ctx.setFillColor(CGColor(gray: 1, alpha: 1))
            ctx.fill(rect)
            ctx.restoreGState()
            ctx.saveGState()
            ctx.clip(to: rect)
            switch board.art {
            case .pdf(let page, _):
                pdfLock.lock()
                ctx.concatenate(page.getDrawingTransform(.cropBox, rect: rect, rotate: 0, preserveAspectRatio: true))
                ctx.drawPDFPage(page)
                pdfLock.unlock()
            case .image(let image):
                ctx.interpolationQuality = z >= 2 ? .none : .high
                let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = gc
                image.draw(in: rect)
                NSGraphicsContext.restoreGraphicsState()
            }
            ctx.restoreGState()
            if boards.count > 1 { drawLabel(board.name, above: rect, in: ctx) }
        }
    }

    /// The artboard's name over its top-left corner, a fixed 11 pt at any zoom, in the window's muted ink.
    private func drawLabel(_ text: String, above rect: CGRect, in ctx: CGContext) {
        let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor(white: 0.62, alpha: 1)]
        let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = gc
        NSString(string: text).draw(at: CGPoint(x: rect.minX, y: rect.maxY + 5), withAttributes: attrs)
        NSGraphicsContext.restoreGraphicsState()
    }
}

/// A tiled layer whose new tiles appear at once (no cross-fade).
private final class InstantTiledLayer: CATiledLayer {
    override class func fadeDuration() -> CFTimeInterval { 0 }
}

/// The window onto the pasteboard. Trackpad: pinch zooms about the pointer, two fingers pan. Space+drag pans, a mouse
/// wheel with Command or Option zooms; Command +, -, 0 (fit all) and 1 (100%).
@MainActor final class CanvasNSView: NSView {
    private let boards: [CanvasBoard]
    private let frames: [CGRect]
    private let renderer: CanvasRenderer
    private let tiled = InstantTiledLayer()
    private var committed = CanvasViewport()
    private var live = CanvasViewport()
    private var laidOut = false
    private var settle: Task<Void, Never>?
    private var spaceDown = false
    private var dragging = false
    var onChange: ((Double, Int?) -> Void)?

    init(boards: [CanvasBoard], frames: [CGRect]) {
        self.boards = boards
        self.frames = frames
        renderer = CanvasRenderer(boards: boards, frames: frames)
        super.init(frame: .zero)
        wantsLayer = true
        applyPasteboard()
        tiled.delegate = renderer
        tiled.anchorPoint = .zero
        tiled.tileSize = CGSize(width: 512, height: 512)
        tiled.levelsOfDetail = 1
        tiled.levelsOfDetailBias = 0
        tiled.isOpaque = false
        tiled.needsDisplayOnBoundsChange = false
        layer?.addSublayer(tiled)
    }
    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override var isFlipped: Bool { false }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyPasteboard()
    }

    private func applyPasteboard() {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.backgroundColor = NSColor(Theme.pasteboard).cgColor }
    }

    override func layout() {
        super.layout()
        guard bounds.width > 0, bounds.height > 0 else { return }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tiled.bounds = CGRect(origin: .zero, size: bounds.size)
        tiled.position = .zero
        tiled.contentsScale = window?.backingScaleFactor ?? 2
        CATransaction.commit()
        if !laidOut {
            laidOut = true
            live = .fitting(ArtboardLayout.bounds(frames), in: bounds.size)
        }
        commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        tiled.contentsScale = window.backingScaleFactor
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, window.firstResponder is NSText == false else { return }
            window.makeFirstResponder(self)
        }
    }

    // MARK: Viewport

    /// Fit `rect` (world) to the window, animated by simply jumping: a settled redraw follows at once.
    func show(_ rect: CGRect) {
        guard bounds.width > 0 else { return }
        live = .fitting(rect, in: bounds.size)
        commit()
    }

    func zoomStep(in zoomIn: Bool) {
        let c = CGPoint(x: bounds.midX, y: bounds.height - bounds.midY)
        live = live.zoomed(to: CanvasZoom.step(live.zoom, in: zoomIn), anchor: c)
        commit()
    }

    func zoomTo(_ z: Double) {
        live = live.zoomed(to: z, anchor: CGPoint(x: bounds.midX, y: bounds.height - bounds.midY))
        commit()
    }

    /// Draw crisp at `live` now: reset the preview and re-render the tiles.
    private func commit() {
        settle?.cancel()
        committed = live
        renderer.set(.init(viewport: live, height: bounds.height))
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tiled.setAffineTransform(.identity)
        tiled.setNeedsDisplay()
        CATransaction.commit()
        publish()
    }

    /// During a gesture: move the existing layer to match `live`, and redraw once the gesture rests.
    private func previewLive() {
        let p = live.preview(from: committed)
        let h = bounds.height
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // y-down translate and scale to the layer's y-up space.
        tiled.setAffineTransform(CGAffineTransform(a: p.scale, b: 0, c: 0, d: p.scale, tx: p.translate.width, ty: h * (1 - p.scale) - p.translate.height))
        CATransaction.commit()
        publish()
        settle?.cancel()
        settle = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(140))
            guard !Task.isCancelled else { return }
            self?.commit()
        }
    }

    private func publish() {
        let centre = live.world(fromView: CGPoint(x: bounds.midX, y: bounds.height / 2))
        onChange?(live.zoom, ArtboardLayout.nearest(frames, to: centre))
    }

    private func viewPoint(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: p.x, y: bounds.height - p.y)
    }

    // MARK: Input

    override func magnify(with event: NSEvent) {
        live = live.zoomed(to: live.zoom * CanvasZoom.factor(magnification: Double(event.magnification)), anchor: viewPoint(event))
        previewLive()
    }

    override func scrollWheel(with event: NSEvent) {
        if event.modifierFlags.contains(.command) || event.modifierFlags.contains(.option) {
            let dy = Double(event.scrollingDeltaY) * (event.hasPreciseScrollingDeltas ? 0.01 : 0.05)
            live = live.zoomed(to: live.zoom * (1 + dy), anchor: viewPoint(event))
        } else {
            live = live.panned(byView: CGSize(width: event.scrollingDeltaX, height: event.scrollingDeltaY))
        }
        previewLive()
    }

    override func keyDown(with event: NSEvent) {
        if event.characters == " " { spaceDown = true; window?.invalidateCursorRects(for: self); NSCursor.openHand.set() } else { super.keyDown(with: event) }
    }
    override func keyUp(with event: NSEvent) {
        if event.characters == " " { spaceDown = false; NSCursor.arrow.set() } else { super.keyUp(with: event) }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        dragging = spaceDown
        if dragging { NSCursor.closedHand.set() }
    }
    override func mouseDragged(with event: NSEvent) {
        guard dragging else { return }
        live = live.panned(byView: CGSize(width: event.deltaX, height: event.deltaY))
        previewLive()
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        (spaceDown ? NSCursor.openHand : NSCursor.arrow).set()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .control, .option]) == .command,
            let w = window, w.isKeyWindow, let ch = event.charactersIgnoringModifiers,
            bounds.contains(convert(w.mouseLocationOutsideOfEventStream, from: nil)) || w.firstResponder === self
        else { return false }
        switch ch {
        case "+", "=": zoomStep(in: true)
        case "-": zoomStep(in: false)
        case "0": show(ArtboardLayout.bounds(frames))
        case "1": zoomTo(1)
        default: return false
        }
        return true
    }
}
