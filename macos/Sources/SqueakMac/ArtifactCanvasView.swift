import AppKit
import PDFKit
import SqueakMacCore
import SwiftUI

// The artifact canvas: an Adobe-like unlimited pasteboard for Illustrator files, one-page PDFs, SVG and pictures.
// Artboards are white pages with a soft shadow, side by side with their names; vector art is redrawn at the current
// scale by a CATiledLayer drawing in WORLD coordinates. An NSScrollView with native magnification handles zoom and
// pan — CATiledLayer refines detail per level on its own, so tiles are never invalidated by gestures.

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
    @ObservationIgnored let view: CanvasScrollView

    var switcher: (index: Int, count: Int)? { (index, boards.count) }
    var zoomLevel: Double? { zoomValue }

    init(boards: [CanvasBoard]) {
        self.boards = boards
        frames = ArtboardLayout.place(boards.map(\.size))
        view = CanvasScrollView(boards: boards, frames: frames)
        view.onChange = { [weak self] zoom, nearest in
            guard let self else { return }
            if zoom != zoomValue { zoomValue = zoom }
            if let nearest, nearest != index { index = nearest }
        }
    }

    func step(_ by: Int) {
        let next = ArtifactSwitcher.stepped(index, by: by, count: boards.count)
        index = next
        view.scrollTo(worldRect: frames[next])
    }
    func zoomStep(in zoomIn: Bool) { view.zoomStep(in: zoomIn) }
    func fit() { view.fitAll() }
}

struct ArtifactCanvasViewer: View {
    let controller: CanvasController
    var body: some View { CanvasHost(view: controller.view) }
}

private struct CanvasHost: NSViewRepresentable {
    let view: CanvasScrollView
    func makeNSView(context: Context) -> CanvasScrollView { view }
    func updateNSView(_ v: CanvasScrollView, context: Context) {}
}

// MARK: - World-space tiled renderer

/// Draws the boards on a CATiledLayer in WORLD coordinates from background threads.
/// Pan and zoom never invalidate tiles; CATiledLayer refines detail per level on its own.
private final class WorldTiledRenderer: NSObject, CALayerDelegate, @unchecked Sendable {
    private let pdfLock = NSLock()
    private let stateLock = NSLock()
    private var storedBoards: [CanvasBoard]
    private var storedFrames: [CGRect]

    init(boards: [CanvasBoard], frames: [CGRect]) { storedBoards = boards; storedFrames = frames }

    /// A canvas of artboards drawn by web views swaps a board's picture while the viewer is open.
    func set(boards: [CanvasBoard], frames: [CGRect]) {
        stateLock.lock(); storedBoards = boards; storedFrames = frames; stateLock.unlock()
    }

    func draw(_ layer: CALayer, in ctx: CGContext) {
        stateLock.lock(); let boards = storedBoards, frames = storedFrames; stateLock.unlock()
        let clip = ctx.boundingBoxOfClipPath
        for (i, board) in boards.enumerated() {
            let f = frames[i]
            // CATiledLayer in a flipped document view: origin is top-left, y increases downward.
            let rect = f
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
                // PDF pages draw in a y-up coordinate system. Flip inside the board rect.
                ctx.saveGState()
                ctx.translateBy(x: rect.minX, y: rect.maxY)
                ctx.scaleBy(x: 1, y: -1)
                let localRect = CGRect(origin: .zero, size: rect.size)
                ctx.concatenate(page.getDrawingTransform(.cropBox, rect: localRect, rotate: 0, preserveAspectRatio: true))
                ctx.drawPDFPage(page)
                ctx.restoreGState()
                pdfLock.unlock()
            case .image(let image):
                // Current magnification from the CTM: a 512pt tile at 2× zoom has a 1024pt CTM scale.
                let ctm = ctx.ctm
                let scale = hypot(ctm.a, ctm.c) // approximate magnification from the transform
                ctx.interpolationQuality = scale >= 2 ? .none : .high
                // NSImage draws y-up; flip inside the board rect.
                ctx.saveGState()
                ctx.translateBy(x: rect.minX, y: rect.maxY)
                ctx.scaleBy(x: 1, y: -1)
                let gc = NSGraphicsContext(cgContext: ctx, flipped: false)
                NSGraphicsContext.saveGraphicsState()
                NSGraphicsContext.current = gc
                image.draw(in: CGRect(origin: .zero, size: rect.size))
                NSGraphicsContext.restoreGraphicsState()
                ctx.restoreGState()
            }
            ctx.restoreGState()
        }
    }
}

/// A tiled layer whose new tiles appear at once (no cross-fade).
private final class InstantTiledLayer: CATiledLayer {
    override class func fadeDuration() -> CFTimeInterval { 0 }
}

// MARK: - Label overlay layer

/// A non-tiled overlay that draws board names at a fixed 11 pt regardless of magnification.
private final class LabelOverlayDelegate: NSObject, CALayerDelegate, @unchecked Sendable {
    private var storedBoards: [CanvasBoard]
    private var storedFrames: [CGRect]
    private var storedAlways = false
    private let lock = NSLock()
    private var storedMagnification: Double = 1

    init(boards: [CanvasBoard], frames: [CGRect]) { storedBoards = boards; storedFrames = frames }

    func set(boards: [CanvasBoard], frames: [CGRect], alwaysLabel: Bool) {
        lock.lock(); storedBoards = boards; storedFrames = frames; storedAlways = alwaysLabel; lock.unlock()
    }

    var magnification: Double {
        get { lock.lock(); defer { lock.unlock() }; return storedMagnification }
        set { lock.lock(); storedMagnification = newValue; lock.unlock() }
    }

    func draw(_ layer: CALayer, in ctx: CGContext) {
        lock.lock(); let boards = storedBoards, frames = storedFrames, always = storedAlways; lock.unlock()
        guard boards.count > 1 || (always && !boards.isEmpty) else { return }
        let mag = magnification
        // Font size divided by magnification so it appears as 11 pt on screen.
        let fontSize = 11.0 / mag
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: fontSize),
            .foregroundColor: NSColor(white: 0.62, alpha: 1),
        ]
        // The layer draws in world coordinates (the document view's coordinate system).
        // In a flipped view, y=0 is top, so labels go above the board (y - offset).
        let gap = 5.0 / mag
        let gc = NSGraphicsContext(cgContext: ctx, flipped: true)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = gc
        for (i, board) in boards.enumerated() {
            let f = frames[i]
            let pt = CGPoint(x: f.minX, y: f.minY - gap - fontSize)
            NSString(string: board.name).draw(at: pt, withAttributes: attrs)
        }
        NSGraphicsContext.restoreGraphicsState()
    }
}

// MARK: - The flipped document view backed by a CATiledLayer

/// The document view inside the scroll view. Sized to the world bounds + padding. Draws artboards via CATiledLayer.
private final class CanvasDocumentView: NSView {
    override var isFlipped: Bool { true }

    let renderer: WorldTiledRenderer
    let labelDelegate: LabelOverlayDelegate
    let tiledLayer = InstantTiledLayer()
    let labelLayer = CALayer()

    init(boards: [CanvasBoard], frames: [CGRect]) {
        renderer = WorldTiledRenderer(boards: boards, frames: frames)
        labelDelegate = LabelOverlayDelegate(boards: boards, frames: frames)
        super.init(frame: .zero)
        wantsLayer = true
        // Configure the tiled layer for world-space drawing.
        tiledLayer.delegate = renderer
        tiledLayer.anchorPoint = .zero
        tiledLayer.tileSize = CGSize(width: 512, height: 512)
        tiledLayer.levelsOfDetail = 12
        tiledLayer.levelsOfDetailBias = 7
        tiledLayer.isOpaque = false
        tiledLayer.needsDisplayOnBoundsChange = true
        layer?.addSublayer(tiledLayer)
        // The label overlay: non-tiled, redrawn when magnification changes.
        labelLayer.delegate = labelDelegate
        labelLayer.anchorPoint = .zero
        labelLayer.isOpaque = false
        labelLayer.needsDisplayOnBoundsChange = true
        layer?.addSublayer(labelLayer)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tiledLayer.frame = bounds
        tiledLayer.contentsScale = window?.backingScaleFactor ?? 2
        labelLayer.frame = bounds
        labelLayer.contentsScale = window?.backingScaleFactor ?? 2
        CATransaction.commit()
    }

    func set(boards: [CanvasBoard], frames: [CGRect], alwaysLabel: Bool) {
        renderer.set(boards: boards, frames: frames)
        labelDelegate.set(boards: boards, frames: frames, alwaysLabel: alwaysLabel)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        tiledLayer.setNeedsDisplay()
        labelLayer.setNeedsDisplay()
        CATransaction.commit()
    }

    func updateLabels(magnification: Double) {
        labelDelegate.magnification = magnification
        CATransaction.begin(); CATransaction.setDisableActions(true)
        labelLayer.setNeedsDisplay()
        CATransaction.commit()
    }
}

// MARK: - The scroll view

/// An NSScrollView that provides native magnification (pinch/trackpad zoom) and scroll for the canvas.
/// CATiledLayer draws in world coordinates; tiles are never invalidated by pan or zoom.
@MainActor final class CanvasScrollView: NSView {
    private var boards: [CanvasBoard]
    private var frames: [CGRect]
    private var artboardBounds: CGRect
    private let scrollView = NSScrollView()
    private let documentView: CanvasDocumentView
    private var laidOut = false
    private var spaceDown = false
    private var dragging = false
    nonisolated(unsafe) private var boundsObserver: NSObjectProtocol?
    var onChange: ((Double, Int?) -> Void)?
    /// A canvas being edited: the live page sits over one board; clicks on a board or on the bare pasteboard, and the
    /// keys the page does not take, are told to the editor.
    var onBoardClick: ((Int) -> Void)?
    var onBackgroundClick: (() -> Void)?
    var onKeyCommand: ((NSEvent) -> Bool)?
    /// The live page's scale on screen (its size over the board's), told whenever it moves or zooms.
    var onLiveScale: ((Double) -> Void)?
    private weak var live: NSView?
    private var liveIndex: Int?
    /// The world point the document view's top-left shows, as the tiled layer was last set up with.
    private var appliedOrigin = CGPoint.zero

    init(boards: [CanvasBoard], frames: [CGRect]) {
        self.boards = boards
        self.frames = frames
        artboardBounds = ArtboardLayout.bounds(frames)
        documentView = CanvasDocumentView(boards: boards, frames: frames)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.drawsBackground = true
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay
        scrollView.verticalScrollElasticity = .allowed
        scrollView.horizontalScrollElasticity = .allowed
        scrollView.allowsMagnification = true
        scrollView.minMagnification = CGFloat(CanvasZoom.range.lowerBound)
        scrollView.maxMagnification = CGFloat(CanvasZoom.range.upperBound)
        scrollView.documentView = documentView
        scrollView.usesPredominantAxisScrolling = false

        addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        applyPasteboard()

        // Observe clip view bounds changes (pan + zoom) to publish state.
        let clipView = scrollView.contentView
        clipView.postsBoundsChangedNotifications = true
        boundsObserver = NotificationCenter.default.addObserver(
            forName: NSView.boundsDidChangeNotification, object: clipView, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.boundsChanged() }
        }
    }
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        if let obs = boundsObserver { NotificationCenter.default.removeObserver(obs) }
    }

    override var acceptsFirstResponder: Bool { true }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyPasteboard()
    }

    private func applyPasteboard() {
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let color = NSColor(Theme.pasteboard).cgColor
            scrollView.backgroundColor = NSColor(cgColor: color) ?? .black
            scrollView.contentView.layer?.backgroundColor = color
            layer?.backgroundColor = color
        }
    }

    override func layout() {
        super.layout()
        guard bounds.width > 0, bounds.height > 0 else { return }
        updateDocumentSize()
        if !laidOut, artboardBounds.width > 0 {
            laidOut = true
            fitAll()
        }
        syncLive()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        guard let window else { return }
        documentView.tiledLayer.contentsScale = window.backingScaleFactor
        documentView.labelLayer.contentsScale = window.backingScaleFactor
        DispatchQueue.main.async { [weak self, weak window] in
            guard let self, let window, window.firstResponder is NSText == false else { return }
            window.makeFirstResponder(self)
        }
    }

    // MARK: Document size

    /// The boards changed (a redrawn picture, a new size, a new artboard): draw them again, keeping zoom and position
    /// unless `refit`. `alwaysLabel` names a single board too.
    func update(boards: [CanvasBoard], frames: [CGRect], alwaysLabel: Bool = false, refit: Bool = false) {
        self.boards = boards
        self.frames = frames
        artboardBounds = ArtboardLayout.bounds(frames)
        documentView.set(boards: boards, frames: frames, alwaysLabel: alwaysLabel)
        updateDocumentSize(force: true)
        if refit { fitAll() } else { publish() }
        syncLive()
    }

    // MARK: The live page

    /// Puts `view` exactly over the board at `index` (nil removes it). It follows pan and zoom from then on.
    func setLive(_ view: NSView?, boardIndex index: Int?) {
        if live !== view {
            live?.removeFromSuperview()
            live = view
            if let view { addSubview(view, positioned: .above, relativeTo: scrollView) }
        }
        liveIndex = view == nil ? nil : index
        syncLive()
    }

    /// The live page's frame: the board's rectangle as the scroll view shows it now (the clip view's bounds carry pan and
    /// magnification, so converting the document-space rectangle is all it takes).
    private func syncLive() {
        guard let live, let i = liveIndex, frames.indices.contains(i), bounds.width > 0 else { return }
        let docOrigin = appliedOrigin
        let world = frames[i]
        let rect = documentView.convert(world.offsetBy(dx: -docOrigin.x, dy: -docOrigin.y), to: self).standardized
        guard rect.width > 0, rect.height > 0 else { return }
        if live.frame != rect {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            live.frame = rect
            CATransaction.commit()
        }
        onLiveScale?(Double(rect.width / max(world.width, 1)))
    }

    /// The board under a mouse event, by its place on the pasteboard.
    private func boardIndex(at event: NSEvent) -> Int? {
        let p = documentView.convert(event.locationInWindow, from: nil)
        let world = CGPoint(x: p.x + appliedOrigin.x, y: p.y + appliedOrigin.y)
        return frames.firstIndex { $0.contains(world) }
    }

    /// The live page hands over what it cannot scroll or pinch itself, so panning and zooming never stop over a board.
    func forwardScroll(_ event: NSEvent) { scrollView.scrollWheel(with: event) }
    func forwardMagnify(_ event: NSEvent) { scrollView.magnify(with: event) }

    private func updateDocumentSize(force: Bool = false) {
        let visibleSize = scrollView.contentView.bounds.size
        let docSize = CanvasDocumentSize.documentSize(artboardBounds: artboardBounds, viewportSize: visibleSize)
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: artboardBounds, viewportSize: visibleSize)
        // Position the artboards within the document view: the document view's origin in world coords is `docOrigin`,
        // so each artboard's frame in document-view coordinates is offset by -docOrigin.
        let docFrame = CGRect(origin: .zero, size: docSize)
        if force || documentView.frame != docFrame {
            documentView.frame = docFrame
            // The tiled layer's bounds should match, offset so that world coords map correctly.
            CATransaction.begin(); CATransaction.setDisableActions(true)
            documentView.tiledLayer.bounds = CGRect(origin: CGPoint(x: docOrigin.x, y: docOrigin.y), size: docSize)
            documentView.tiledLayer.position = .zero
            documentView.labelLayer.bounds = CGRect(origin: CGPoint(x: docOrigin.x, y: docOrigin.y), size: docSize)
            documentView.labelLayer.position = .zero
            CATransaction.commit()
            appliedOrigin = docOrigin
        }
    }

    // MARK: Navigation

    func scrollTo(worldRect: CGRect) {
        guard bounds.width > 0 else { return }
        let visibleSize = scrollView.contentView.bounds.size
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: artboardBounds, viewportSize: visibleSize)
        let mag = CanvasDocumentSize.fitMagnification(rect: worldRect, viewportSize: visibleSize, maxMag: scrollView.magnification)
        scrollView.magnification = CGFloat(mag)
        let pt = CanvasDocumentSize.centredScrollPoint(
            worldRect: worldRect, magnification: mag, viewportSize: visibleSize, docOrigin: docOrigin)
        scrollView.contentView.setBoundsOrigin(pt)
        documentView.updateLabels(magnification: mag)
        publish()
    }

    func zoomStep(in zoomIn: Bool) {
        let current = Double(scrollView.magnification)
        let next = CanvasZoom.step(current, in: zoomIn)
        let centre = CGPoint(x: bounds.midX, y: bounds.midY)
        let inScrollView = convert(centre, to: scrollView)
        NSAnimationContext.runAnimationGroup { ctx in
            // DESIGN.md §7: motion-standard, ease-out; nothing travels under Reduce Motion.
            ctx.duration = Motion.reduceMotion ? 0 : 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            scrollView.animator().setMagnification(CGFloat(next), centeredAt: inScrollView)
        }
    }

    func zoomTo(_ z: Double) {
        let centre = CGPoint(x: bounds.midX, y: bounds.midY)
        let inScrollView = convert(centre, to: scrollView)
        NSAnimationContext.runAnimationGroup { ctx in
            // DESIGN.md §7: motion-standard, ease-out; nothing travels under Reduce Motion.
            ctx.duration = Motion.reduceMotion ? 0 : 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            scrollView.animator().setMagnification(CGFloat(CanvasZoom.clamp(z)), centeredAt: inScrollView)
        }
    }

    func fitAll() {
        guard bounds.width > 0, artboardBounds.width > 0 else { return }
        let visibleSize = scrollView.contentView.bounds.size
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: artboardBounds, viewportSize: visibleSize)
        let mag = CanvasDocumentSize.fitMagnification(rect: artboardBounds, viewportSize: visibleSize)
        scrollView.magnification = CGFloat(mag)
        let pt = CanvasDocumentSize.centredScrollPoint(
            worldRect: artboardBounds, magnification: mag, viewportSize: visibleSize, docOrigin: docOrigin)
        scrollView.contentView.setBoundsOrigin(pt)
        documentView.updateLabels(magnification: mag)
        publish()
    }

    // MARK: State publishing

    private func boundsChanged() {
        let mag = Double(scrollView.magnification)
        documentView.updateLabels(magnification: mag)
        publish()
        syncLive()
    }

    private func publish() {
        let mag = Double(scrollView.magnification)
        // Visible centre in document-view coordinates, then to world coordinates.
        let clipBounds = scrollView.contentView.bounds
        let centreInDoc = CGPoint(x: clipBounds.midX / CGFloat(mag), y: clipBounds.midY / CGFloat(mag))
        let visibleSize = scrollView.contentView.bounds.size
        let docOrigin = CanvasDocumentSize.documentOrigin(artboardBounds: artboardBounds, viewportSize: visibleSize)
        let worldCentre = CGPoint(x: centreInDoc.x + docOrigin.x, y: centreInDoc.y + docOrigin.y)
        onChange?(mag, ArtboardLayout.nearest(frames, to: worldCentre))
    }

    // MARK: Input

    override func keyDown(with event: NSEvent) {
        if event.characters == " " { spaceDown = true; window?.invalidateCursorRects(for: self); NSCursor.openHand.set() } else { super.keyDown(with: event) }
    }
    override func keyUp(with event: NSEvent) {
        if event.characters == " " { spaceDown = false; NSCursor.arrow.set() } else { super.keyUp(with: event) }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        dragging = spaceDown
        if dragging { NSCursor.closedHand.set(); return }
        if let i = boardIndex(at: event) { onBoardClick?(i) } else { onBackgroundClick?() }
    }
    override func mouseDragged(with event: NSEvent) {
        guard dragging else { return }
        // Pan by adjusting the clip view's bounds origin.
        var origin = scrollView.contentView.bounds.origin
        origin.x -= event.deltaX
        origin.y -= event.deltaY
        scrollView.contentView.setBoundsOrigin(origin)
    }
    override func mouseUp(with event: NSEvent) {
        dragging = false
        (spaceDown ? NSCursor.openHand : NSCursor.arrow).set()
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection([.command, .control, .option]) == .command,
            let w = window, w.isKeyWindow, let ch = event.charactersIgnoringModifiers,
            bounds.contains(convert(w.mouseLocationOutsideOfEventStream, from: nil)) || w.firstResponder === self
                || ((w.firstResponder as? NSView).map { live != nil && $0.isDescendant(of: live!) } ?? false)
        else { return false }
        if live != nil, onKeyCommand?(event) == true { return true }
        switch ch {
        case "+", "=": zoomStep(in: true)
        case "-": zoomStep(in: false)
        case "0": fitAll()
        case "1": zoomTo(1)
        default: return false
        }
        return true
    }
}
