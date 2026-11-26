import AppKit
import Quartz
import SqueakMacCore
import SwiftUI

/// Where an inline chip finds its picture and what a click on it opens. The composer's field and the transcript share it.
@MainActor
final class InlineChipSource {
    /// Pictures not yet saved (the composer's tray).
    weak var tray: ImageTray?
    /// The chat's folder: a saved token's path is relative to it.
    var folder: String?
    private var cache: [String: NSImage] = [:]

    init(tray: ImageTray? = nil, folder: String? = nil) {
        self.tray = tray
        self.folder = folder
    }

    func absolute(_ path: String) -> String {
        path.hasPrefix("/") ? path : ((folder.map { $0 + "/" + path }) ?? path)
    }

    /// The chip's thumbnail: the tray's for a pending picture, else the file's (read once, small).
    func thumb(_ token: InlineAttachments.Token) -> NSImage? {
        if let id = token.pendingId { return tray?.item(pendingId: id)?.thumb }
        guard token.isImage else { return nil }
        let path = absolute(token.path)
        if let hit = cache[path] { return hit }
        guard let image = NSImage(contentsOfFile: path) else { return nil }
        cache[path] = image
        return image
    }

    /// A file a preview can show: the saved file, or the pending picture written to a temporary file.
    func previewURL(_ token: InlineAttachments.Token) -> URL? {
        if let id = token.pendingId {
            guard let item = tray?.item(pendingId: id) else { return nil }
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-preview", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("\(id).\(item.image.ext)")
            if !FileManager.default.fileExists(atPath: url.path) { try? item.image.data.write(to: url) }
            return url
        }
        let url = URL(fileURLWithPath: absolute(token.path))
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func open(_ token: InlineAttachments.Token) {
        guard let url = previewURL(token) else { NSSound.beep(); return }
        QuickLookPanel.shared.show(url)
    }
}

/// The system's Quick Look panel on one file (a chip's picture), opened from a click.
@MainActor
final class QuickLookPanel: NSObject, @preconcurrency QLPreviewPanelDataSource {
    static let shared = QuickLookPanel()
    private var url: URL?

    func show(_ url: URL) {
        self.url = url
        guard let panel = QLPreviewPanel.shared() else { NSWorkspace.shared.open(url); return }
        panel.dataSource = self
        panel.reloadData()
        panel.makeKeyAndOrderFront(nil)
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { url == nil ? 0 : 1 }
    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! { url as NSURL? }
}

/// One inline chip as an image the text system lays out like a character (DESIGN.md §8.12): a `selected` pill, radius 6,
/// 22pt tall, a 16pt rounded thumbnail (or a file glyph), the name in 12pt `ink`, and a slot at the end where the remove ✕
/// shows on hover (the slot is always there, so hovering never reflows the text). Drawn when shown, so it follows the
/// window's appearance and picks up a thumbnail that arrives later.
enum InlineChipImage {
    static let height: CGFloat = 22
    static let thumb: CGFloat = 16
    static let removeSlot: CGFloat = 14
    nonisolated(unsafe) static let font = NSFont.systemFont(ofSize: 12)

    static func size(for token: InlineAttachments.Token) -> NSSize {
        let name = InlineAttachments.chipName(token.name) as NSString
        let w = ceil(name.size(withAttributes: [.font: font]).width)
        return NSSize(width: 4 + thumb + 6 + w + 2 + removeSlot, height: height)
    }

    /// The ✕'s rect inside the chip (chip coordinates, origin bottom left).
    static func removeRect(in size: NSSize) -> NSRect {
        NSRect(x: size.width - removeSlot - 1, y: (size.height - 13) / 2, width: 13, height: 13)
    }

    static func make(_ token: InlineAttachments.Token, source: InlineChipSource?, hovered isHovered: @escaping @MainActor () -> Bool = { false }) -> NSImage {
        let size = size(for: token)
        let image = NSImage(size: size, flipped: false) { rect in
            let hovered = MainActor.assumeIsolated { isHovered() }
            let pill = NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 6, yRadius: 6)
            NSColor(Theme.selectedStrong).withAlphaComponent(hovered ? 1 : 0.85).setFill()
            pill.fill()
            NSColor(Theme.lineStrong).setStroke()
            pill.lineWidth = 0.5
            pill.stroke()
            let t = NSRect(x: 4, y: (rect.height - thumb) / 2, width: thumb, height: thumb)
            if let picture = MainActor.assumeIsolated({ source?.thumb(token) }) {
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(roundedRect: t, xRadius: 3, yRadius: 3).addClip()
                let s = picture.size, scale = max(t.width / max(s.width, 1), t.height / max(s.height, 1))
                let drawn = NSSize(width: s.width * scale, height: s.height * scale)
                picture.draw(in: NSRect(x: t.midX - drawn.width / 2, y: t.midY - drawn.height / 2, width: drawn.width, height: drawn.height))
                NSGraphicsContext.restoreGraphicsState()
            } else {
                let symbol = token.isImage ? "photo" : "doc"
                let config = NSImage.SymbolConfiguration(pointSize: 11, weight: .regular)
                    .applying(.init(paletteColors: [NSColor(Theme.muted)]))
                if let glyph = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(config) {
                    let g = glyph.size
                    glyph.draw(in: NSRect(x: t.midX - g.width / 2, y: t.midY - g.height / 2, width: g.width, height: g.height))
                }
            }
            let name = InlineAttachments.chipName(token.name) as NSString
            let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor(Theme.ink)]
            let nameSize = name.size(withAttributes: attrs)
            name.draw(at: NSPoint(x: t.maxX + 6, y: (rect.height - nameSize.height) / 2), withAttributes: attrs)
            if hovered {
                let x = removeRect(in: rect.size)
                NSColor(Theme.surfaceRaised).setFill()
                NSBezierPath(ovalIn: x).fill()
                NSColor(Theme.muted).setStroke()
                let cross = NSBezierPath()
                cross.lineWidth = 1.3
                cross.lineCapStyle = .round
                let i = x.insetBy(dx: 4, dy: 4)
                cross.move(to: NSPoint(x: i.minX, y: i.minY)); cross.line(to: NSPoint(x: i.maxX, y: i.maxY))
                cross.move(to: NSPoint(x: i.minX, y: i.maxY)); cross.line(to: NSPoint(x: i.maxX, y: i.minY))
                cross.stroke()
            }
            return true
        }
        image.cacheMode = .never
        return image
    }
}

extension NSAttributedString.Key {
    /// On a chip's attachment character: the token it stands for, exactly as stored.
    static let squeakToken = NSAttributedString.Key("squeak.inlineToken")
}

/// The chip as an attachment, aligned to sit on the text's line (14/22).
@MainActor
enum InlineChipAttachment {
    /// `hovered` answers, when the chip is drawn, whether the pointer is over this attachment (the ✕ shows).
    static func string(_ token: InlineAttachments.Token, source: InlineChipSource?, hovered: (@MainActor (NSTextAttachment) -> Bool)? = nil,
                       attributes: [NSAttributedString.Key: Any]) -> NSAttributedString {
        let attachment = NSTextAttachment()
        let box = WeakAttachment(attachment)
        let image = InlineChipImage.make(token, source: source) {
            guard let a = box.value, let hovered else { return false }
            return hovered(a)
        }
        attachment.image = image
        attachment.bounds = NSRect(x: 0, y: -6, width: image.size.width, height: image.size.height)
        let s = NSMutableAttributedString(attachment: attachment)
        var attrs = attributes
        attrs[.squeakToken] = token.raw
        s.addAttributes(attrs, range: NSRange(location: 0, length: s.length))
        return s
    }
}

/// The chip's image asks, when drawn, whether its own attachment is the hovered one; it must not keep it alive.
private final class WeakAttachment: @unchecked Sendable {
    weak var value: NSTextAttachment?
    init(_ value: NSTextAttachment) { self.value = value }
}
