import AppKit
import SwiftUI

/// The menu-bar duck: a vector template image (see `DuckGlyphPath`, traced from the master art).
///
/// A template image is drawn in black with alpha and macOS tints it for light or dark menu bars,
/// so the whole image, count included, is one template. Rendered from paths at the backing scale
/// of whatever draws it, so it is crisp at 1x and 2x.
enum MenuBarIcon {
    enum State: Equatable {
        case normal
        case needsYou(Int)
        case offline
    }

    /// The duck's box in the menu bar, in points.
    static let boxSize = CGSize(width: 22, height: 18)
    /// Duck height inside the box (a point of air above and below).
    private static let duckHeight: CGFloat = 16
    /// Below this height the wing line is thinner than a pixel and just muddies the body.
    private static let wingMinHeight: CGFloat = 24

    static func image(for state: State, height: CGFloat = 18, wing: Bool? = nil) -> NSImage {
        let k = height / boxSize.height
        let duckH = duckHeight * k
        let duckW = duckH * DuckGlyphPath.aspect
        var text: NSAttributedString?
        var alpha: CGFloat = 1
        var width = boxSize.width * k
        switch state {
        case .normal: break
        case .offline: alpha = 0.45
        case .needsYou(let n):
            let t = NSAttributedString(
                string: n > 99 ? "99+" : "\(n)",
                attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12.5 * k, weight: .semibold), .foregroundColor: NSColor.black])
            text = t
            width = ((boxSize.width - duckW / k) / 2 + duckW / k) * k + 2 * k + ceil(t.size().width) + 2 * k
        }
        let withWing = wing ?? (height >= wingMinHeight)
        let size = CGSize(width: width, height: height)
        let image = NSImage(size: size, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.setAlpha(alpha)
            ctx.setFillColor(NSColor.black.cgColor)
            // Optical centring: the duck's mass sits low and left, so nudge it up half a pixel's worth.
            let originX = text == nil ? (size.width - duckW) / 2 : (boxSize.width * k - duckW) / 2
            let rect = CGRect(x: originX, y: (size.height - duckH) / 2 - 0.25 * k, width: duckW, height: duckH)
            let path = CGMutablePath()
            path.addPath(DuckGlyphPath.body(in: rect))
            let eye = DuckGlyphPath.eye(in: rect)
            if withWing {
                path.addPath(eye)
                path.addPath(DuckGlyphPath.wing(in: rect))
            } else {
                // At menu-bar size the true eye is ~1.5 px across and washes out; open it up a touch.
                path.addEllipse(in: eye.boundingBox.insetBy(dx: -0.3 * k, dy: -0.3 * k))
            }
            ctx.addPath(path)
            ctx.fillPath(using: .evenOdd)
            if let text {
                let s = text.size()
                NSGraphicsContext.current?.saveGraphicsState()
                // The context is flipped; draw text upright.
                text.draw(at: CGPoint(x: rect.maxX + 2 * k, y: (size.height - s.height) / 2))
                NSGraphicsContext.current?.restoreGraphicsState()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}

/// The duck as a SwiftUI shape, for the brand glyph anywhere in the app. Fill with
/// `.fill(style: FillStyle(eoFill: true))` so the eye (and wing) are cut out.
struct DuckShape: Shape {
    var showsWing = true

    func path(in rect: CGRect) -> Path {
        let p = CGMutablePath()
        p.addPath(DuckGlyphPath.body(in: rect))
        p.addPath(DuckGlyphPath.eye(in: rect))
        if showsWing { p.addPath(DuckGlyphPath.wing(in: rect)) }
        return Path(p)
    }
}

extension MenuBarIcon.State {
    @MainActor init(model: AppModel) {
        if !model.isConnected { self = .offline }
        else if model.attentionCount > 0 { self = .needsYou(model.attentionCount) }
        else { self = .normal }
    }
}

// MARK: Contact sheet (SQUEAK_MAC_ICON_SHEET=<png>)

enum MenuBarIconSheet {
    @MainActor static func write(to path: String, master: String?) {
        let W = 1100, H = 760
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
            let gc = NSGraphicsContext(bitmapImageRep: rep) else { return }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = gc
        let ctx = gc.cgContext
        ctx.translateBy(x: 0, y: CGFloat(H)); ctx.scaleBy(x: 1, y: -1)  // y down
        NSColor(white: 0.5, alpha: 1).setFill(); CGRect(x: 0, y: 0, width: W, height: H).fill()

        func label(_ s: String, _ x: CGFloat, _ y: CGFloat) {
            let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.white]
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: true)
            NSAttributedString(string: s, attributes: a).draw(at: CGPoint(x: x, y: y))
            NSGraphicsContext.restoreGraphicsState()
        }
        /// Draws the template image tinted, at `scale` device pixels per point, 1 pixel = 1 sheet pixel.
        func tinted(_ img: NSImage, at p: CGPoint, scale: CGFloat, color: NSColor, smooth: Bool = true) {
            let pw = Int(ceil(img.size.width * scale)), ph = Int(ceil(img.size.height * scale))
            guard let r = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                let g = NSGraphicsContext(bitmapImageRep: r) else { return }
            NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = g
            img.draw(in: CGRect(x: 0, y: 0, width: pw, height: ph))
            color.setFill()
            CGRect(x: 0, y: 0, width: pw, height: ph).fill(using: .sourceIn)
            NSGraphicsContext.restoreGraphicsState()
            guard let cg = r.cgImage else { return }
            ctx.saveGState()
            ctx.interpolationQuality = smooth ? .high : .none
            ctx.translateBy(x: p.x, y: p.y + CGFloat(ph) * (smooth ? 1 : 1)); ctx.scaleBy(x: 1, y: -1)
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: pw, height: ph))
            ctx.restoreGState()
        }

        let states: [(String, MenuBarIcon.State)] = [("normal", .normal), ("needs you 2", .needsYou(2)), ("offline", .offline)]
        let bars: [(String, NSColor, NSColor)] = [
            ("light menu bar", NSColor(white: 0.91, alpha: 1), .black), ("dark menu bar", NSColor(white: 0.16, alpha: 1), .white),
        ]
        var y: CGFloat = 20
        for (name, bg, fg) in bars {
            label(name + "  (1x pixels, then 2x pixels)", 20, y); y += 18
            for (sname, st) in states {
                bg.setFill(); CGRect(x: 20, y: y, width: 520, height: 44).fill()
                label(sname, 28, y + 14)
                tinted(MenuBarIcon.image(for: st), at: CGPoint(x: 150, y: y + 13), scale: 1, color: fg)
                tinted(MenuBarIcon.image(for: st), at: CGPoint(x: 250, y: y + 4), scale: 2, color: fg)
                y += 50
            }
            y += 10
        }
        // 8x enlargements of the normal icon: true pixels (nearest) and vector.
        label("1x pixels at 8x (nearest)", 580, 20)
        tinted(MenuBarIcon.image(for: .normal), at: CGPoint(x: 580, y: 40), scale: 1, color: .black, smooth: true)
        // nearest enlargement: render 1x then scale
        do {
            let img = MenuBarIcon.image(for: .normal)
            if let r = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: 22, pixelsHigh: 18, bitsPerSample: 8, samplesPerPixel: 4,
                hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
                let g = NSGraphicsContext(bitmapImageRep: r) {
                NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = g
                NSColor.white.setFill(); CGRect(x: 0, y: 0, width: 22, height: 18).fill()
                img.draw(in: CGRect(x: 0, y: 0, width: 22, height: 18))
                NSGraphicsContext.restoreGraphicsState()
                if let cg = r.cgImage {
                    ctx.saveGState(); ctx.interpolationQuality = .none
                    ctx.translateBy(x: 580, y: 40 + 18 * 8); ctx.scaleBy(x: 1, y: -1)
                    ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 22 * 8, height: 18 * 8))
                    ctx.restoreGState()
                }
            }
        }
        label("vector at 8x (menu-bar variant, no wing)", 780, 20)
        NSColor.white.setFill(); CGRect(x: 780, y: 40, width: 22 * 8, height: 18 * 8).fill()
        tinted(MenuBarIcon.image(for: .normal, height: 18 * 8, wing: false), at: CGPoint(x: 780, y: 40), scale: 1, color: .black)

        // Large render with wing, DuckShape in duck yellow, and the master for comparison.
        label("large (wing kept) 144pt", 580, 205)
        NSColor.white.setFill(); CGRect(x: 580, y: 225, width: 176, height: 176).fill()
        tinted(MenuBarIcon.image(for: .normal, height: 144, wing: true), at: CGPoint(x: 580, y: 225), scale: 1, color: .black)

        label("DuckShape 64pt, duck yellow", 780, 205)
        NSColor(white: 0.1, alpha: 1).setFill(); CGRect(x: 780, y: 225, width: 176, height: 176).fill()
        do {
            let p = DuckShape().path(in: CGRect(x: 812, y: 257, width: 64, height: 64))
            ctx.saveGState(); ctx.addPath(p.cgPath); ctx.setFillColor(NSColor(Theme.duck).cgColor); ctx.fillPath(using: .evenOdd)
            let p2 = DuckShape(showsWing: false).path(in: CGRect(x: 884, y: 257, width: 64, height: 64))
            ctx.addPath(p2.cgPath); ctx.fillPath(using: .evenOdd); ctx.restoreGState()
        }

        label("master (left) vs trace overlay at 280pt (trace red on master)", 580, 420)
        if let master, let src = NSImage(contentsOfFile: master), let cg = src.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            ctx.saveGState(); ctx.translateBy(x: 580, y: 440 + 280); ctx.scaleBy(x: 1, y: -1)
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 280, height: 280)); ctx.restoreGState()
            ctx.saveGState(); ctx.translateBy(x: 880, y: 440 + 280); ctx.scaleBy(x: 1, y: -1)
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 280, height: 280)); ctx.restoreGState()
            // Overlay: the master's duck box is the bbox of the dark pixels; use its measured bounds.
            if let b = darkBounds(cg) {
                let s = 280.0 / CGFloat(cg.width)
                let r = CGRect(x: 880 + b.minX * s, y: 440 + b.minY * s, width: b.width * s, height: b.height * s)
                let p = DuckShape().path(in: r)
                ctx.saveGState(); ctx.addPath(p.cgPath); ctx.setStrokeColor(NSColor.red.cgColor); ctx.setLineWidth(1); ctx.strokePath()
                ctx.restoreGState()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
        if let data = rep.representation(using: .png, properties: [:]) {
            try? FileManager.default.createDirectory(
                at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: URL(fileURLWithPath: path))
        }
    }

    /// Bounding box (top-left origin, pixels) of the dark pixels in the master.
    private static func darkBounds(_ cg: CGImage) -> CGRect? {
        let w = cg.width, h = cg.height
        var buf = [UInt8](repeating: 255, count: w * h)
        guard let c = CGContext(
            data: &buf, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return nil }
        c.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var minX = w, minY = h, maxX = 0, maxY = 0
        for y in 0..<h { for x in 0..<w where buf[y * w + x] < 128 {
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
        } }
        return maxX > minX ? CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY) : nil
    }
}
