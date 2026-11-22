import AppKit
import AVKit
import ImageIO
import PDFKit
import QuickLookThumbnailing
import SqueakIcons
import SqueakMacCore
import SwiftUI
import WebKit

// The artifact viewer: an artifact opened full size in the centre (`WorkbenchLocation.artifact`), a layer over the chat
// or the pond page with a back control. One viewer, chosen by `ArtifactPreview.kind(for:)`; heavy files load off the main
// thread, and a file that is gone says so. The Artifacts tab keeps the list.

/// What is read off the disk for a viewer.
private enum ViewerContent {
    case missing
    case web(URL)
    case markdown(String, URL)
    case pdf(PDFBox)
    case image(NSImage, pixels: CGSize)
    case quickLook(URL)
    case media(URL, audio: Bool)
    /// Illustrator with no PDF inside: its large thumbnail (when Quick Look has one) and the way to open it.
    case illustrator(NSImage?)
}

/// A PDF document handed from the loading task to the main actor (PDFKit documents are read on the main actor only).
private struct PDFBox: @unchecked Sendable { let document: PDFDocument }

struct ArtifactViewerPage: View {
    let pond: String
    let path: String
    let sidebarHidden: Bool
    let inspectorOpen: Bool
    @Environment(AppModel.self) private var model
    @State private var content: ViewerContent?
    @State private var slides: Int?
    @State private var systemApp: String?
    @State private var illustratorURL: URL?
    /// A remote pond's file once the owner's Mac has sent it: the cached copy on this Mac. Until then there is nothing to open.
    @State private var fetched: RemoteArtifactFile?
    @State private var fetching: Fetch?

    private enum Fetch: Equatable { case downloading(Double?), failed(String) }

    /// A remote pond's artifact: `path` is the owner's wire id, not a path.
    private var remote: Bool { PondsModel.shared.chrome(key: pond).inspectorPeopleRecentOnly }
    private var ownerMac: String { PondsModel.shared.chrome(key: pond).ownerMac }
    /// What the viewer reads: the cached copy for a remote pond (empty until it arrives), else the file itself.
    private var filePath: String { remote ? (fetched?.path ?? "") : path }
    private var url: URL { URL(fileURLWithPath: filePath) }

    private var item: ArtifactItem {
        if remote {
            if let hit = RemoteArtifactsStore.shared.model(for: pond).items.first(where: { $0.path == path }) { return hit }
            if let f = fetched { return ArtifactItem(path: path, name: f.name, kind: f.kind, size: f.size) }
            return ArtifactItem(path: path, name: "File")
        }
        let id = PondsModel.shared.native(key: pond)?.id
        if let id, let hit = ArtifactsStore.shared.model(for: id).items.first(where: { $0.path == path }) { return hit }
        let attrs = try? FileManager.default.attributesOfItem(atPath: path)
        return ArtifactItem(
            path: path, modifiedAt: (attrs?[.modificationDate] as? Date) ?? Date(), size: (attrs?[.size] as? NSNumber)?.int64Value ?? 0)
    }

    private var isMissing: Bool { if case .missing = content { true } else { false } }

    var body: some View {
        let item = item
        VStack(spacing: 0) {
            header(item)
            toolbar(item)
            Rectangle().fill(Theme.line).frame(height: 1)
            viewer(item)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: path) {
            content = nil; slides = nil; fetched = nil; fetching = nil
            if remote {
                guard await download() else { return }
            }
            let local = filePath
            let found = await ArtifactLoader.load(path: local)
            content = found
            if case .quickLook = found { slides = await ArtifactLoader.slideCount(path: local) }
        }
        .task(id: filePath) {
            systemApp = ArtifactLoader.defaultAppName(for: url)
            illustratorURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.adobe.illustrator")
        }
    }

    /// Asks the owner's Mac for the file and waits for it (progress shown); false when it did not come.
    private func download() async -> Bool {
        guard let pondId = PondsModel.shared.pond(key: pond)?.id else { fetching = .failed("This pond is not available."); return false }
        fetching = .downloading(nil)
        do {
            let answer = try await RemoteArtifacts.waitForFile(
                PondsClient(host: model.nativeHost), pond: pondId, id: path, progress: { p in Task { @MainActor in fetching = .downloading(p) } })
            switch answer {
            case .ready(let file): fetched = file; fetching = nil; return true
            case .failed(let why): fetching = .failed(why)
            case .pending: fetching = .failed(RemoteArtifacts.offline(ownerMac))
            }
        } catch is CancellationError {
        } catch {
            fetching = .failed("Squeak couldn\u{2019}t fetch this file. Try again.")
        }
        return false
    }

    // MARK: Header and toolbar

    private func header(_ item: ArtifactItem) -> some View {
        var extras: [String] = []
        if remote { extras.append(RemoteArtifacts.fromLine(ownerMac)) }
        if let slides { extras.append(slides == 1 ? "1 slide" : "\(slides) slides") }
        if case .image(_, let px) = content, px.width > 0 { extras.append("\(Int(px.width)) \u{00D7} \(Int(px.height))") }
        return HStack(spacing: Space.s) {
            if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve - Space.l) }
            Button { model.closeArtifact() } label: {
                Lucide(.arrowLeft, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Back").accessibilityLabel("Close the viewer")
            Lucide(item.kind.lucide, size: 15, color: Theme.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: item.name).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text(verbatim: Artifacts.viewerMeta(item, extras: extras)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: Space.m)
            if !inspectorOpen { Color.clear.frame(width: PaneToggle.size) }
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }

    private func toolbar(_ item: ArtifactItem) -> some View {
        HStack(spacing: Space.s) {
            Button(Artifacts.openLabel(kind: item.kind, systemApp: systemApp)) { openDefault() }
                .buttonStyle(SecondaryButtonStyle()).disabled(isMissing || (remote && fetched == nil))
            Button("Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                .buttonStyle(SecondaryButtonStyle()).disabled(isMissing || (remote && fetched == nil))
            if !remote || fetched != nil { ArtifactCopyPath(path: filePath) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.l).frame(height: 40)
    }

    private func openDefault() {
        if systemApp != nil { NSWorkspace.shared.open(url) } else { ArtifactLoader.openWith(url) }
    }

    // MARK: Body

    @ViewBuilder private func viewer(_ item: ArtifactItem) -> some View {
        Group {
            switch content {
            case nil:
                waiting
            case .missing:
                message(title: "This file was moved or deleted", detail: filePath)
            case .web(let u): ArtifactWebPage(url: u)
            case .markdown(let text, let u): MarkdownFilePreview(text: text, fileURL: u, root: u.deletingLastPathComponent())
            case .pdf(let box): ArtifactPDFViewer(document: box.document)
            case .image(let image, _): ImageCanvas(image: image, name: item.name)
            case .quickLook(let u): QuickLookPreview(url: u)
            case .media(let u, let audio): ArtifactMediaPlayer(url: u, audio: audio)
            case .illustrator(let thumb): illustrator(thumb)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .id(path)
    }

    /// Before the content is read: "Opening", or a remote file's download with its progress, or why it did not come.
    @ViewBuilder private var waiting: some View {
        switch fetching {
        case .downloading(let p)?:
            VStack(spacing: Space.s) {
                if let p, p > 0 { ProgressView(value: min(p, 1)).frame(width: 220) } else { ProgressView().controlSize(.small) }
                Text(verbatim: RemoteArtifacts.downloading(p)).font(Typo.body).foregroundStyle(Theme.muted)
                Text(verbatim: RemoteArtifacts.fromLine(ownerMac)).font(Typo.meta).foregroundStyle(Theme.subtle)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed(let why)?:
            VStack(spacing: Space.s) {
                Text("Couldn\u{2019}t get this file").font(Typo.heading).foregroundStyle(Theme.ink)
                Text(verbatim: why).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                Button("Try again") { Task { if await download() { content = await ArtifactLoader.load(path: filePath) } } }
                    .buttonStyle(SecondaryButtonStyle())
            }
            .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
        case nil:
            Text("Opening\u{2026}").font(Typo.body).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func message(title: String, detail: String) -> some View {
        VStack(spacing: Space.s) {
            Image(nsImage: NSWorkspace.shared.icon(for: .data)).resizable().frame(width: 64, height: 64).opacity(0.6)
            Text(verbatim: title).font(Typo.heading).foregroundStyle(Theme.ink)
            Text(verbatim: detail).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
        }
        .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// An Illustrator file without PDF compatibility: the biggest thumbnail Quick Look has, and the way to open it.
    private func illustrator(_ thumb: NSImage?) -> some View {
        VStack(spacing: Space.m) {
            if let thumb {
                Image(nsImage: thumb).resizable().scaledToFit().frame(maxWidth: 720, maxHeight: 520)
                    .overlay(Rectangle().strokeBorder(Theme.line))
            } else {
                Image(nsImage: NSWorkspace.shared.icon(forFile: path)).resizable().frame(width: 96, height: 96)
            }
            Text("This Illustrator file has no PDF inside, so Squeak shows only its thumbnail.").font(Typo.body).foregroundStyle(Theme.muted)
            Button(illustratorURL != nil ? "Open in Illustrator" : "Open with\u{2026}") {
                if let app = illustratorURL {
                    NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
                } else {
                    ArtifactLoader.openWith(url)
                }
            }
            .buttonStyle(SecondaryButtonStyle())
        }
        .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ArtifactCopyPath: View {
    let path: String
    @State private var copied = false
    var body: some View {
        Button(copied ? "Copied" : "Copy path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(path, forType: .string)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        }
        .buttonStyle(SecondaryButtonStyle()).accessibilityLabel("Copy path \(path)")
    }
}

// MARK: Loading (off the main thread)

private enum ArtifactLoader {
    static func load(path: String) async -> ViewerContent {
        await Task.detached(priority: .userInitiated) { loadSync(path: path) }.value
    }

    private static func loadSync(path: String) -> ViewerContent {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else { return .missing }
        var choice: ArtifactPreview? = ArtifactPreview.kind(for: path)
        while let c = choice {
            switch c {
            case .web: return .web(url)
            case .markdown:
                if let text = try? String(contentsOf: url, encoding: .utf8) { return .markdown(text, url) }
            case .pdf:
                if let doc = PDFDocument(url: url), doc.pageCount > 0 { return .pdf(PDFBox(document: doc)) }
            case .illustrator:
                if let doc = PDFDocument(url: url), doc.pageCount > 0 { return .pdf(PDFBox(document: doc)) }
                return .illustrator(thumbnail(url))
            case .image, .svg:
                if let (image, px) = image(url) { return .image(image, pixels: px) }
            case .quickLook, .other: return .quickLook(url)
            case .media:
                let audio = ["m4a", "mp3", "wav", "aac"].contains(url.pathExtension.lowercased())
                return .media(url, audio: audio)
            }
            choice = ArtifactPreview.fallback(after: c)
        }
        return .quickLook(url)
    }

    /// ImageIO reads PNG, JPEG, GIF, WebP, TIFF, HEIC and flattens a Photoshop file; a huge picture is capped at 8192 px.
    private static func image(_ url: URL) -> (NSImage, CGSize)? {
        if url.pathExtension.lowercased() == "svg" {
            guard let image = NSImage(contentsOf: url), image.isValid, image.size.width > 0 else { return nil }
            return (image, .zero)
        }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        let w = (props?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
        let h = (props?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
        let cg: CGImage?
        if max(w, h) > 8192 {
            cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 8192,
            ] as CFDictionary)
        } else {
            cg = CGImageSourceCreateImageAtIndex(source, 0, nil)
        }
        guard let cg else {
            guard let image = NSImage(contentsOf: url), image.isValid else { return nil }
            return (image, image.size)
        }
        let image = NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        return (image, CGSize(width: w > 0 ? w : Double(cg.width), height: h > 0 ? h : Double(cg.height)))
    }

    /// The largest thumbnail Quick Look will make (nil when it has none).
    private static func thumbnail(_ url: URL) -> NSImage? {
        let box = ThumbBox()
        let done = DispatchSemaphore(value: 0)
        let request = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: 1024, height: 1024), scale: 2, representationTypes: .thumbnail)
        QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { rep, _ in
            box.image = rep?.nsImage
            done.signal()
        }
        _ = done.wait(timeout: .now() + 8)
        return box.image
    }

    private final class ThumbBox: @unchecked Sendable { var image: NSImage? }

    /// Slides in a PowerPoint file, from its zip's entry names (no unpacking). nil for any other file or on failure.
    static func slideCount(path: String) async -> Int? {
        guard (path as NSString).pathExtension.lowercased() == "pptx" else { return nil }
        return await Task.detached(priority: .utility) {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
            p.arguments = ["-Z1", path]
            let pipe = Pipe()
            p.standardOutput = pipe
            p.standardError = FileHandle.nullDevice
            do { try p.run() } catch { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            p.waitUntilExit()
            guard p.terminationStatus == 0 else { return nil }
            return SlideCount.pptx(entries: String(decoding: data, as: UTF8.self).split(separator: "\n").map(String.init))
        }.value
    }

    /// The name of the app the system opens the file with, without ".app"; nil when there is none.
    static func defaultAppName(for url: URL) -> String? {
        guard let app = NSWorkspace.shared.urlForApplication(toOpen: url) else { return nil }
        return FileManager.default.displayName(atPath: app.path).replacingOccurrences(of: ".app", with: "")
    }

    /// "Open with...": choose an application and open the file in it.
    @MainActor static func openWith(_ url: URL) {
        let panel = NSOpenPanel()
        panel.title = "Open with"
        panel.message = "Choose the app to open \(url.lastPathComponent) with."
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.allowedContentTypes = [.application]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let app = panel.url else { return }
        NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration())
    }
}

// MARK: PDF

/// PDFKit with continuous scroll, a page-thumbnail sidebar, "Page n of m" and zoom in, out and fit.
@MainActor @Observable
private final class PDFController {
    let view = PDFView()
    private(set) var page = 1
    let count: Int

    init(document: PDFDocument) {
        count = document.pageCount
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.autoScales = true
        view.document = document
    }

    func pageChanged() {
        guard let doc = view.document, let current = view.currentPage else { return }
        page = doc.index(for: current) + 1
    }

    func zoom(_ factor: CGFloat) {
        view.autoScales = false
        view.scaleFactor = min(max(view.scaleFactor * factor, view.minScaleFactor), min(view.maxScaleFactor, 8))
    }
    func fit() { view.autoScales = true }
    func step(_ by: Int) {
        guard let doc = view.document, let p = doc.page(at: min(max(page - 1 + by, 0), count - 1)) else { return }
        view.go(to: p)
    }
}

private struct ArtifactPDFViewer: View {
    let document: PDFDocument
    @State private var controller: PDFController

    init(document: PDFDocument) {
        self.document = document
        _controller = State(initialValue: PDFController(document: document))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Button { controller.step(-1) } label: { Image(systemName: "chevron.up").frame(width: 24, height: 24) }
                    .buttonStyle(SecondaryButtonStyle()).help("Previous page").accessibilityLabel("Previous page")
                Button { controller.step(1) } label: { Image(systemName: "chevron.down").frame(width: 24, height: 24) }
                    .buttonStyle(SecondaryButtonStyle()).help("Next page").accessibilityLabel("Next page")
                Text(verbatim: "Page \(controller.page) of \(controller.count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                Spacer(minLength: Space.s)
                Button("Fit") { controller.fit() }.buttonStyle(SecondaryButtonStyle()).help("Fit to the window")
                Button { controller.zoom(1 / 1.25) } label: { Image(systemName: "minus").frame(width: 24, height: 24) }
                    .buttonStyle(SecondaryButtonStyle()).help("Zoom out").accessibilityLabel("Zoom out")
                Button { controller.zoom(1.25) } label: { Image(systemName: "plus").frame(width: 24, height: 24) }
                    .buttonStyle(SecondaryButtonStyle()).help("Zoom in").accessibilityLabel("Zoom in")
            }
            .padding(.horizontal, Space.m).frame(height: 36)
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 0) {
                if controller.count > 1 {
                    PDFThumbnails(pdfView: controller.view).frame(width: 128)
                    Rectangle().fill(Theme.line).frame(width: 1)
                }
                PDFHost(view: controller.view)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .PDFViewPageChanged, object: controller.view)) { _ in controller.pageChanged() }
    }
}

private struct PDFHost: NSViewRepresentable {
    let view: PDFView
    func makeNSView(context: Context) -> PDFView { view }
    func updateNSView(_ v: PDFView, context: Context) {}
}

private struct PDFThumbnails: NSViewRepresentable {
    let pdfView: PDFView
    func makeNSView(context: Context) -> PDFThumbnailView {
        let t = PDFThumbnailView()
        t.pdfView = pdfView
        t.thumbnailSize = CGSize(width: 90, height: 120)
        t.backgroundColor = .clear
        return t
    }
    func updateNSView(_ v: PDFThumbnailView, context: Context) {}
}

// MARK: Web and media

/// An HTML page or slide deck a duck wrote, drawn as a page. It may read its own folder (images, styles, scripts) and
/// nothing else; it takes the keyboard so arrow keys move a deck.
private struct ArtifactWebPage: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        v.setValue(false, forKey: "drawsBackground")
        v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        DispatchQueue.main.async { [weak v] in v?.window?.makeFirstResponder(v) }
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {}
}

private struct ArtifactMediaPlayer: View {
    let url: URL
    let audio: Bool
    var body: some View {
        ZStack {
            if audio { Lucide(.file, size: 64, color: Theme.subtle) }
            AVPlayerHost(url: url)
        }
    }
}

private struct AVPlayerHost: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> AVPlayerView {
        let v = AVPlayerView()
        v.controlsStyle = .inline
        v.player = AVPlayer(url: url)
        return v
    }
    func updateNSView(_ v: AVPlayerView, context: Context) {}
    static func dismantleNSView(_ v: AVPlayerView, coordinator: ()) { v.player?.pause(); v.player = nil }
}
