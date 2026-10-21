import AppKit

/// The menu-bar mark (DESIGN.md §6.3): the template generated from the approved logo by
/// `brand/logo/make-tray-icon.py` (`brand/logo/png/duckTemplate.png`, `@2x`), never redrawn here.
///
/// A template image is black with alpha and macOS tints it for light or dark menu bars, so the needs-you
/// count is drawn into the same template. Offline draws the same mark at reduced opacity.
enum MenuBarIcon {
    enum State: Equatable {
        case normal
        case needsYou(Int)
        case offline
        /// An awake session runs: what is left ("1:52", "∞" until ended), drawn after the mark.
        case awake(String)
    }

    /// The mark's size in points (the 18 px file at 1x, 36 px at 2x).
    static let markSize = NSSize(width: 18, height: 18)

    private static let mark: NSImage? = {
        let image = NSImage(size: markSize)
        for name in ["duckTemplate.png", "duckTemplate@2x.png"] {
            guard let url = BrandAssets.url(name), let data = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: data) else { continue }
            rep.size = markSize
            image.addRepresentation(rep)
        }
        return image.representations.isEmpty ? nil : image
    }()

    static func image(for state: State) -> NSImage {
        var alpha: CGFloat = 1
        var text: NSAttributedString?
        var width = markSize.width
        switch state {
        case .normal: break
        case .offline: alpha = 0.45
        case .needsYou(let n):
            let t = NSAttributedString(
                string: n > 99 ? "99+" : "\(n)",
                attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: NSColor.black])
            text = t
            width += 2 + ceil(t.size().width) + 2
        case .awake(let left):
            let t = NSAttributedString(
                string: left,
                attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), .foregroundColor: NSColor.black])
            text = t
            width += 3 + ceil(t.size().width) + 2
        }
        let image = NSImage(size: NSSize(width: width, height: markSize.height), flipped: false) { rect in
            mark?.draw(in: NSRect(origin: .zero, size: markSize), from: .zero, operation: .sourceOver, fraction: alpha)
            if let text {
                let s = text.size()
                text.draw(at: NSPoint(x: markSize.width + 2, y: (rect.height - s.height) / 2))
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}

extension MenuBarIcon.State {
    @MainActor init(model: AppModel) {
        if !model.isConnected { self = .offline }
        else if model.attentionCount > 0 { self = .needsYou(model.attentionCount) }
        else if let awake = model.awake { self = .awake(Self.left(awake.until)) }
        else { self = .normal }
    }

    /// "1:52" left (hours:minutes), "12m" under an hour, "∞" for a session that runs until ended.
    static func left(_ until: Date?, now: Date = Date()) -> String {
        guard let until else { return "∞" }
        let minutes = max(0, Int((until.timeIntervalSince(now) / 60).rounded(.up)))
        return minutes < 60 ? "\(minutes)m" : "\(minutes / 60):\(String(format: "%02d", minutes % 60))"
    }
}
