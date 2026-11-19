import AppKit
import SqueakMacCore
import SwiftUI

/// The Dashboard <-> Room slide at the Core Animation level. At the start of a drag or a switch both pages are captured as
/// bitmaps and shown here as two layers above the live pages; the drag, the finish and a grab mid-finish only move these
/// layers (no SwiftUI state per frame, no layout of the pages), like Safari's back swipe. The live pages stay put beneath
/// and take over, once, when the glide ends.
@MainActor
final class PondSnapshotStrip: NSView {
    private var pageLayers: [PondPage: CALayer] = [:]
    private var scrims: [PondPage: CALayer] = [:]
    private var link: CADisplayLink?
    private var framesLeft = 0
    private var dismissToken = 0

    override init(frame: NSRect) { super.init(frame: frame) }

    /// The backing layer and the two page layers exist only while a slide is showing; at rest the view has no layer at all.
    private func build() {
        guard pageLayers.isEmpty else { return }
        wantsLayer = true
        layer?.masksToBounds = true
        for page in PondPage.allCases {
            let l = CALayer(); l.contentsGravity = .resize; l.masksToBounds = true
            let s = CALayer(); s.opacity = 0
            l.addSublayer(s)
            layer?.addSublayer(l)
            pageLayers[page] = l; scrims[page] = s
        }
    }
    required init?(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }

    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for page in PondPage.allCases { pageLayers[page]?.bounds = CGRect(origin: .zero, size: bounds.size); pageLayers[page]?.position = CGPoint(x: bounds.midX, y: bounds.midY); scrims[page]?.frame = bounds }
        CATransaction.commit()
    }

    // MARK: Capture

    /// The hosting view the pages live in.
    private func host() -> NSView? {
        var v: NSView? = superview
        while let x = v { if String(describing: type(of: x)).contains("HostingView") { return x }; v = x.superview }
        return window?.contentView
    }

    /// Lays the hosting view out now (the staged page, applied synchronously), so the next capture sees it.
    func sync() { host()?.layoutSubtreeIfNeeded() }

    /// The pages' region of the hosting view as a bitmap at the backing scale, or nil.
    func capture() -> NSBitmapImageRep? {
        guard let host = host() else { return nil }
        let r = host.convert(bounds, from: self)
        guard r.width > 1, r.height > 1, let rep = host.bitmapImageRepForCachingDisplay(in: r) else { return nil }
        host.cacheDisplay(in: r, to: rep)
        return rep
    }

    static func identical(_ a: NSBitmapImageRep, _ b: NSBitmapImageRep) -> Bool {
        guard a.pixelsWide == b.pixelsWide, a.pixelsHigh == b.pixelsHigh, a.bytesPerRow == b.bytesPerRow,
              let pa = a.bitmapData, let pb = b.bitmapData else { return false }
        return memcmp(pa, pb, a.bytesPerRow * a.pixelsHigh) == 0
    }

    // MARK: Show

    /// Puts the captures on the layers, the page at `rest` leaving and the other arriving on top, at `position`, and shows the strip.
    func show(images: [PondPage: CGImage], rest: PondPage, position: Double) {
        dismissToken += 1; link?.invalidate(); link = nil
        build()
        let scale = window?.backingScaleFactor ?? 2
        var bg = CGColor(gray: 0, alpha: 1)
        effectiveAppearance.performAsCurrentDrawingAppearance { bg = NSColor(Theme.bg).cgColor }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        layer?.backgroundColor = bg
        for page in PondPage.allCases {
            guard let l = pageLayers[page] else { continue }
            l.removeAllAnimations(); scrims[page]?.removeAllAnimations()
            l.contents = images[page]; l.contentsScale = scale
            l.zPosition = PondSnapshotPlan.zPosition(of: page, rest: rest)
            scrims[page]?.backgroundColor = bg
        }
        CATransaction.commit()
        layout()
        place(position: position)
        isHidden = false
    }

    // MARK: Move

    private func x(_ page: PondPage, _ position: Double) -> Double { PondSnapshotPlan.x(of: page, position: position, width: Double(bounds.width)) }
    private func scrim(_ page: PondPage, _ position: Double) -> Float { Float(PondSnapshotPlan.scrim(x: x(page, position), width: Double(bounds.width))) }

    /// Moves the strip to `position` at once, no implicit animation.
    func place(position: Double) {
        CATransaction.begin(); CATransaction.setDisableActions(true)
        for page in PondPage.allCases {
            pageLayers[page]?.setValue(x(page, position), forKeyPath: "transform.translation.x")
            scrims[page]?.opacity = scrim(page, position)
        }
        CATransaction.commit()
    }

    /// Where the strip is on screen now (the layers' presentation), or nil when it is not showing.
    func presentedPosition() -> Double? {
        guard !isHidden, bounds.width > 1, let l = pageLayers[.dashboard] else { return nil }
        let live = l.presentation() ?? l
        guard let tx = live.value(forKeyPath: "transform.translation.x") as? Double else { return nil }
        return -tx / Double(bounds.width)
    }

    /// Stops a glide where it is, so a grab continues from the very spot.
    func freeze() {
        guard let p = presentedPosition() else { return }
        for page in PondPage.allCases { pageLayers[page]?.removeAllAnimations(); scrims[page]?.removeAllAnimations() }
        place(position: p)
    }

    /// Glides from `from` to `to` over `duration` on the swipe curve, both layers and both scrims; `done` runs when it ends
    /// (also if it is stopped, so the caller checks it is still the current one).
    func glide(from: Double, to: Double, duration: Double, done: @escaping () -> Void) {
        let curve = CAMediaTimingFunction(controlPoints: Float(SwipeCurve.x1), Float(SwipeCurve.y1), Float(SwipeCurve.x2), Float(SwipeCurve.y2))
        CATransaction.begin()
        CATransaction.setCompletionBlock(done)
        CATransaction.setDisableActions(true)
        for page in PondPage.allCases {
            guard let l = pageLayers[page], let s = scrims[page] else { continue }
            l.removeAllAnimations(); s.removeAllAnimations()
            let (x0, x1) = (x(page, from), x(page, to))
            l.setValue(x1, forKeyPath: "transform.translation.x")
            let a = CABasicAnimation(keyPath: "transform.translation.x")
            a.fromValue = x0; a.toValue = x1; a.duration = duration; a.timingFunction = curve
            l.add(a, forKey: "glide")
            let (o0, o1) = (scrim(page, from), scrim(page, to))
            s.opacity = o1
            let b = CABasicAnimation(keyPath: "opacity")
            b.fromValue = o0; b.toValue = o1; b.duration = duration; b.timingFunction = curve
            s.add(b, forKey: "glide")
        }
        CATransaction.commit()
    }

    // MARK: Hide

    /// Hides the strip after the next `frames` display frames, by which the live page has drawn once; a new `show` cancels it.
    func dismiss(afterFrames frames: Int = 2) {
        dismissToken += 1
        framesLeft = frames
        link?.invalidate()
        let l = displayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        framesLeft -= 1
        guard framesLeft <= 0 else { return }
        l.invalidate(); link = nil
        clear()
    }

    /// Nothing left over the live page: hidden, bitmaps dropped, scrims and backdrop cleared.
    func clear() {
        link?.invalidate(); link = nil
        isHidden = true
        for page in PondPage.allCases { pageLayers[page]?.removeAllAnimations(); scrims[page]?.removeAllAnimations() }
        layer?.sublayers?.forEach { $0.removeFromSuperlayer() }
        pageLayers = [:]; scrims = [:]
        layer?.backgroundColor = nil
        wantsLayer = false
    }
}

struct PondSnapshotLayer: NSViewRepresentable {
    let state: PondPanState
    func makeNSView(context: Context) -> PondSnapshotStrip {
        let v = PondSnapshotStrip(); v.isHidden = true; state.strip = v; return v
    }
    func updateNSView(_ view: PondSnapshotStrip, context: Context) { state.strip = view }
    static func dismantleNSView(_ view: PondSnapshotStrip, coordinator: ()) { view.clear() }
}
