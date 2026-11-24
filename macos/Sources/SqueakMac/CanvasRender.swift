import AppKit
import PDFKit
import SqueakMacCore
import WebKit

// Draws a canvas's artboards. Each artboard is a self-contained HTML file; a small pool of web views that are never on
// screen (two, one shared configuration, read access to the canvas folder only, page scripts off) loads it and hands
// back a picture or a PDF page. A slot is taken for one artboard, then blanked and given back, so memory stays flat
// however many artboards a canvas has: there is never a web view per artboard. The live editing page (CanvasEditor) is
// its own, single web view and is not part of the pool.

enum CanvasRenderError: Error {
    case loadFailed
    case snapshotFailed
    case pdfFailed
}

/// A fixed number of reusable offscreen web views. Callers wait their turn (first come, first served) and a waiter
/// that is cancelled leaves the line at once.
@MainActor
final class CanvasRenderPool {
    static let shared = CanvasRenderPool(slots: 2)

    private final class Slot: NSObject, WKNavigationDelegate {
        let web: WKWebView
        private var done: CheckedContinuation<Void, Error>?
        private var navigation: WKNavigation?

        init(configuration: WKWebViewConfiguration) {
            web = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: configuration)
            super.init()
            web.navigationDelegate = self
            web.setValue(false, forKey: "drawsBackground")
        }

        func load(file: URL, readRoot: URL, size: CGSize) async throws {
            web.setFrameSize(size)
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    done = c
                    navigation = web.loadFileURL(file, allowingReadAccessTo: readRoot)
                }
            } onCancel: {
                Task { @MainActor in self.web.stopLoading() }
            }
            try Task.checkCancellation()
            // Web fonts and late pictures: let layout settle once more.
            _ = try? await web.callAsyncJavaScript(
                "await document.fonts.ready; await Promise.all([...document.images].map(i => i.decode().catch(() => {}))); return 1",
                contentWorld: .defaultClient)
            try? await Task.sleep(for: .milliseconds(60))
            try Task.checkCancellation()
        }

        /// Drops the page so an idle slot holds no artboard's memory.
        func blank() {
            navigation = nil
            if let c = done { done = nil; c.resume(throwing: CanvasRenderError.loadFailed) }
            web.loadHTMLString("", baseURL: nil)
        }

        private func finish(_ nav: WKNavigation!, _ result: Result<Void, Error>) {
            guard nav === navigation, let c = done else { return }
            done = nil
            c.resume(with: result)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finish(navigation, .success(())) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            finish(navigation, .failure(CanvasRenderError.loadFailed))
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            finish(navigation, .failure(CanvasRenderError.loadFailed))
        }
    }

    /// One configuration (so one web content process pool) for every slot.
    private static let configuration: WKWebViewConfiguration = {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        return config
    }()

    let slotCount: Int
    private var slots: [Slot] = []
    private var free: [Slot] = []
    private var waiters: [(id: UUID, cont: CheckedContinuation<Slot, Error>)] = []

    init(slots: Int) { slotCount = max(1, slots) }

    private func acquire() async throws -> Slot {
        try Task.checkCancellation()
        if let slot = free.popLast() { return slot }
        if slots.count < slotCount {
            let slot = Slot(configuration: Self.configuration)
            slots.append(slot)
            return slot
        }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Slot, Error>) in
                waiters.append((id, c))
            }
        } onCancel: {
            Task { @MainActor in
                guard let i = self.waiters.firstIndex(where: { $0.id == id }) else { return }
                self.waiters.remove(at: i).cont.resume(throwing: CancellationError())
            }
        }
    }

    private func release(_ slot: Slot) {
        slot.blank()
        if !waiters.isEmpty { waiters.removeFirst().cont.resume(returning: slot) } else { free.append(slot) }
    }

    /// Loads the artboard into a pooled web view sized to it and runs `body` on the settled page; the slot goes back
    /// blank afterwards, whatever happens.
    func withPage<T>(file: URL, readRoot: URL, size: CGSize, _ body: (WKWebView) async throws -> T) async throws -> T {
        let slot = try await acquire()
        defer { release(slot) }
        try await slot.load(file: file, readRoot: readRoot, size: size)
        return try await body(slot.web)
    }
}

@MainActor
enum CanvasRender {
    /// A picture of the artboard. `width` is the picture's width in points; the pool takes it as pixels, so pass
    /// twice the artboard's width for a 2x picture.
    static func image(board: CanvasArtboardInfo, root: URL, width: CGFloat? = nil) async throws -> NSImage {
        try await CanvasRenderPool.shared.withPage(file: URL(fileURLWithPath: board.file), readRoot: root, size: board.size) { web in
            let config = WKSnapshotConfiguration()
            config.rect = CGRect(origin: .zero, size: board.size)
            config.snapshotWidth = NSNumber(value: Double(width ?? board.size.width))
            config.afterScreenUpdates = true
            return try await withCheckedThrowingContinuation { c in
                web.takeSnapshot(with: config) { image, error in
                    if let image { c.resume(returning: image) } else { c.resume(throwing: error ?? CanvasRenderError.snapshotFailed) }
                }
            }
        }
    }

    /// The artboard as a one-page PDF of its own size.
    static func pdfPage(board: CanvasArtboardInfo, root: URL) async throws -> Data {
        try await CanvasRenderPool.shared.withPage(file: URL(fileURLWithPath: board.file), readRoot: root, size: board.size) { web in
            let config = WKPDFConfiguration()
            config.rect = CGRect(origin: .zero, size: board.size)
            return try await withCheckedThrowingContinuation { c in
                web.createPDF(configuration: config) { result in
                    switch result {
                    case .success(let data): c.resume(returning: data)
                    case .failure: c.resume(throwing: CanvasRenderError.pdfFailed)
                    }
                }
            }
        }
    }

    /// PNG bytes of the artboard at exactly `pixels` (the snapshot redrawn into a bitmap of that size).
    static func png(board: CanvasArtboardInfo, root: URL, scale: CanvasExport.Scale) async throws -> Data {
        let pixels = CanvasExport.pixelSize(board.size, scale: scale)
        let image = try await image(board: board, root: root, width: pixels.width)
        return try await Task.detached(priority: .userInitiated) { try Self.encodePNG(image, pixels: pixels) }.value
    }

    nonisolated private static func encodePNG(_ image: NSImage, pixels: CGSize) throws -> Data {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(pixels.width), pixelsHigh: Int(pixels.height), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let ctx = NSGraphicsContext(bitmapImageRep: rep) else { throw CanvasRenderError.snapshotFailed }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        image.draw(in: CGRect(origin: .zero, size: pixels), from: .zero, operation: .copy, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .png, properties: [:]) else { throw CanvasRenderError.snapshotFailed }
        return data
    }

    /// Stitches one-page PDFs into one document, in order. Off the main thread.
    nonisolated static func merge(_ pages: [Data]) -> Data? {
        let doc = PDFDocument()
        for data in pages {
            guard let part = PDFDocument(data: data), let page = part.page(at: 0) else { continue }
            doc.insert(page, at: doc.pageCount)
        }
        return doc.pageCount == 0 ? nil : doc.dataRepresentation()
    }

    /// The placeholder drawn while an artboard has no picture yet: a quiet "Rendering…" on a white board.
    static func placeholder(size: CGSize, text words: String) -> NSImage {
        let box = CGSize(width: 480, height: max(1, 480 * size.height / max(size.width, 1)))
        return NSImage(size: box, flipped: false) { rect in
            NSColor.white.setFill(); rect.fill()
            let attrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 20, weight: .medium), .foregroundColor: NSColor(white: 0.55, alpha: 1)]
            let text = NSString(string: words)
            let s = text.size(withAttributes: attrs)
            text.draw(at: CGPoint(x: rect.midX - s.width / 2, y: rect.midY - s.height / 2), withAttributes: attrs)
            return true
        }
    }
}
