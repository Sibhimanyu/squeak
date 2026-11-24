import AppKit
import AVKit
import ImageIO
import PDFKit
import QuickLookThumbnailing
import SqueakIcons
import SqueakMacCore
import SwiftUI
import WebKit

// The artifact viewer: an artifact opened full size in the centre (`WorkbenchLocation.artifact`), the body of an artifact
// tab in its chat's strip (or, for a pond with no chat, a layer over the page with a back control). One viewer, chosen by `ArtifactPreview.kind(for:)`; heavy files load off the main
// thread, and a file that is gone says so. The Artifacts tab keeps the list.

/// What is read off the disk for a viewer.
private enum ViewerContent {
    case missing
    case web(URL)
    case markdown(String, URL)
    /// A PDF with several pages: PDFKit, paged, with its thumbnail sidebar.
    case pdf(PDFBox)
    /// One-page artwork (an `.ai`, a one-page PDF, SVG, a picture): the pasteboard canvas. `pixels` is a picture's size.
    case canvas([CanvasBoard], pixels: CGSize?)
    case quickLook(URL)
    case media(URL, audio: Bool)
    /// Illustrator with no usable PDF inside (saved without PDF content): its large thumbnail (when Quick Look has one),
    /// the explicit render button and the way to open it.
    case illustrator(NSImage?)
}

/// A PDF document handed from the loading task to the main actor (PDFKit documents are read on the main actor only).
private struct PDFBox: @unchecked Sendable { let document: PDFDocument }

struct ArtifactViewerPage: View {
    let pond: String
    let path: String
    var sidebarHidden = false
    var inspectorOpen = false
    /// The body of an artifact tab: the chat's own header and strip are above, so there is no header or back control,
    /// only the compact toolbar row.
    var embedded = false
    @Environment(AppModel.self) private var model
    @State private var content: ViewerContent?
    @State private var slides: Int?
    @State private var systemApp: String?
    @State private var illustratorURL: URL?
    /// The controls of whichever viewer is showing, for the one toolbar row (nil for pages, media, Quick Look).
    @State private var controller: (any ViewerControlling)?
    @State private var rendering: Rendering = .idle
    /// A remote pond's file once the owner's Mac has sent it: the cached copy on this Mac. Until then there is nothing to open.
    @State private var fetched: RemoteArtifactFile?
    @State private var fetching: Fetch?

    private enum Rendering: Equatable { case idle, running, failed(String) }
    private enum Fetch: Equatable { case downloading(Double?), failed(String) }

    /// A remote pond's artifact: `path` is the owner's wire id, not a path.
    private var remote: Bool { PondsModel.shared.chrome(key: pond).inspectorPeopleRecentOnly }
    private var ownerMac: String { PondsModel.shared.chrome(key: pond).ownerMac }
    /// What the viewer reads: the cached copy for a remote pond (empty until it arrives), else the file itself.
    private var filePath: String { remote ? (fetched?.path ?? "") : path }
    private var url: URL { URL(fileURLWithPath: filePath) }

    private var item: ArtifactItem { Self.item(pond: pond, path: path, remote: remote, fetched: fetched) }

    /// The list's row for an artifact (its duck, branch and kind), else what the file itself says.
    static func item(pond: String, path: String, remote: Bool, fetched: RemoteArtifactFile? = nil) -> ArtifactItem {
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

    /// Whether a pond's artifacts live on another Mac.
    static func isRemote(pond: String) -> Bool { PondsModel.shared.chrome(key: pond).inspectorPeopleRecentOnly }

    private var isMissing: Bool { if case .missing = content { true } else { false } }

    var body: some View {
        if path.hasSuffix(".canvas"), !remote {
            // A canvas is a folder of artboards: its own viewer, with its own toolbar line.
            CanvasViewerPage(pond: pond, path: path, sidebarHidden: sidebarHidden, inspectorOpen: inspectorOpen, embedded: embedded)
        } else if remote, item.kind == .canvas {
            // A remote pond's canvas arrives as one bundle file and is shown view-only.
            RemoteCanvasViewer(pond: pond, id: path, sidebarHidden: sidebarHidden, inspectorOpen: inspectorOpen, embedded: embedded)
        } else {
            fileBody
        }
    }

    private var fileBody: some View {
        let item = item
        return VStack(spacing: 0) {
            if !embedded { header(item) }
            toolbar(item)
            Rectangle().fill(Theme.line).frame(height: 1)
            viewer(item)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: path) {
            content = nil; slides = nil; fetched = nil; fetching = nil; controller = nil; rendering = .idle
            if remote {
                guard await download() else { return }
            }
            let local = filePath
            let found = await ArtifactLoader.load(path: local)
            adopt(found)
            if case .quickLook = found { slides = await ArtifactLoader.slideCount(path: local) }
        }
        .task(id: filePath) {
            systemApp = ArtifactLoader.defaultAppName(for: url)
            illustratorURL = IllustratorRender.app(for: url)
        }
    }

    /// Shows what was read, with the controls of the viewer that draws it.
    private func adopt(_ found: ViewerContent) {
        content = found
        switch found {
        case .canvas(let boards, _): controller = CanvasController(boards: boards)
        case .pdf(let box): controller = PDFController(document: box.document)
        default: controller = nil
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

    private var metaExtras: [String] {
        var extras: [String] = []
        if remote { extras.append(RemoteArtifacts.fromLine(ownerMac)) }
        if let slides { extras.append(slides == 1 ? "1 slide" : "\(slides) slides") }
        if case .canvas(_, let px?) = content, px.width > 0 { extras.append("\(Int(px.width)) \u{00D7} \(Int(px.height))") }
        return extras
    }

    private func header(_ item: ArtifactItem) -> some View {
        let extras = metaExtras
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

    /// One compact line for every kind: switcher and meta at the left, zoom and the actions at the right.
    private func toolbar(_ item: ArtifactItem) -> some View {
        let unavailable = isMissing || (remote && fetched == nil)
        return HStack(spacing: Space.s) {
            if let c = controller, let sw = c.switcher, ArtifactSwitcher.shown(count: sw.count) {
                ToolIcon(.chevronLeft, help: "Previous") { c.step(-1) }.disabled(sw.index == 0)
                Text(verbatim: ArtifactSwitcher.text(index: sw.index, count: sw.count)).font(Typo.meta).monospacedDigit()
                    .foregroundStyle(Theme.muted)
                ToolIcon(.chevronRight, help: "Next") { c.step(1) }.disabled(sw.index >= sw.count - 1)
            }
            if embedded {
                Text(verbatim: Artifacts.viewerMeta(item, extras: metaExtras)).font(Typo.meta).foregroundStyle(Theme.subtle)
                    .lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 0)
            if let c = controller, let z = c.zoomLevel {
                ToolIcon(.minus, help: "Zoom out (\u{2318}-)") { c.zoomStep(in: false) }
                Text(verbatim: CanvasZoom.percentText(z)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    .frame(minWidth: 38)
                ToolIcon(.plus, help: "Zoom in (\u{2318}+)") { c.zoomStep(in: true) }
                Button("Fit") { c.fit() }.buttonStyle(CompactToolStyle()).help("Fit everything (\u{2318}0)")
                Rectangle().fill(Theme.line).frame(width: 1, height: 14).padding(.horizontal, 2)
            }
            Button { openDefault() } label: {
                HStack(spacing: 4) { Lucide(.externalLink, size: 13, color: Theme.ink); Text("Open") }
            }
            .buttonStyle(CompactToolStyle()).disabled(unavailable)
            .help(Artifacts.openLabel(kind: item.kind, systemApp: systemApp)).accessibilityLabel(Artifacts.openLabel(kind: item.kind, systemApp: systemApp))
            ToolIcon(.folder, help: "Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }.disabled(unavailable)
            if !remote || fetched != nil { ArtifactCopyPath(path: filePath) }
        }
        .padding(.horizontal, Space.m).frame(height: 36)
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
            case .pdf:
                if let c = controller as? PDFController { ArtifactPDFViewer(controller: c) }
            case .canvas:
                if let c = controller as? CanvasController { ArtifactCanvasViewer(controller: c) }
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
                Button("Try again") { Task { if await download() { adopt(await ArtifactLoader.load(path: filePath)) } } }
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

    /// An Illustrator file saved without PDF content: say so, offer an explicit render with the installed Illustrator, or
    /// the largest thumbnail Quick Look has and "Open with...".
    private func illustrator(_ thumb: NSImage?) -> some View {
        VStack(spacing: Space.m) {
            // With Illustrator open the file renders as soon as it opens (one per file, cached): never show the
            // placeholder page Illustrator embeds ("saved without PDF content"), only the file icon while it works.
            if illustratorURL == nil, let thumb {
                Image(nsImage: thumb).resizable().scaledToFit().frame(maxWidth: 720, maxHeight: 420)
                    .overlay(Rectangle().strokeBorder(Theme.line))
            } else {
                Image(nsImage: NSWorkspace.shared.icon(forFile: path)).resizable().frame(width: 96, height: 96)
            }
            if illustratorURL == nil || rendering != .running {
                Text(verbatim: IllustratorStub.explanation).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            switch rendering {
            case .running:
                HStack(spacing: Space.s) {
                    ProgressView().controlSize(.small)
                    Text("Rendering with Illustrator\u{2026}").font(Typo.body).foregroundStyle(Theme.muted)
                }
            case .failed(let why):
                Text(verbatim: why).font(Typo.body).foregroundStyle(Theme.negative).multilineTextAlignment(.center).textSelection(.enabled)
                    .frame(maxWidth: 520)
            case .idle: EmptyView()
            }
            HStack(spacing: Space.s) {
                if let app = illustratorURL, rendering != .running {
                    Button(rendering == .idle ? "Render preview with Illustrator" : "Try again") { renderWithIllustrator(app) }
                        .buttonStyle(PrimaryButtonStyle())
                }
                Button("Open with\u{2026}") { ArtifactLoader.openWith(url) }.buttonStyle(SecondaryButtonStyle())
            }
        }
        .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
        // Renders by itself only when Illustrator is already open; otherwise the button asks first (a launch is slow).
        .task(id: path) {
            if let app = illustratorURL,
               IllustratorAuto.shouldRender(appRunning: IllustratorRender.isRunning(app), idle: rendering == .idle) {
                renderWithIllustrator(app)
            }
        }
    }

    private func renderWithIllustrator(_ app: URL) {
        let file = url
        rendering = .running
        Task {
            do {
                let boards = try await IllustratorRender.render(file: file, with: app)
                guard file == url else { return }
                adopt(.canvas(boards, pixels: nil))
                rendering = .idle
            } catch let e as IllustratorRender.Failure {
                rendering = .failed(e.message)
            } catch {
                rendering = .failed("Illustrator could not render this file.")
            }
        }
    }
}

/// Compact tool button (DESIGN.md small control): 24 pt high, `surface-raised` with a `line` edge, `meta` type.
struct CompactToolStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 7)
            .frame(minWidth: 24, minHeight: 24)
            .background(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
            .opacity(isEnabled ? 1 : 0.5)
            .pressFeedback(configuration.isPressed)
    }
}

/// An icon-only compact button with a tooltip and VoiceOver label.
struct ToolIcon: View {
    let name: LucideName
    let help: String
    let action: () -> Void
    init(_ name: LucideName, help: String, action: @escaping () -> Void) { self.name = name; self.help = help; self.action = action }
    var body: some View {
        Button(action: action) { Lucide(name, size: 13, color: Theme.ink) }
            .buttonStyle(CompactToolStyle()).help(help).accessibilityLabel(help)
    }
}

struct ArtifactCopyPath: View {
    let path: String
    @State private var copied = false
    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(path, forType: .string)
            copied = true
            Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
        } label: {
            HStack(spacing: 4) { Lucide(copied ? .check : .copy, size: 13, color: Theme.ink); Text(copied ? "Copied" : "Copy") }
        }
        .buttonStyle(CompactToolStyle()).help("Copy the file\u{2019}s path").accessibilityLabel("Copy path \(path)")
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
                if let doc = PDFDocument(url: url), doc.pageCount > 0 {
                    return doc.pageCount == 1 ? .canvas(CanvasBoard.boards(of: doc), pixels: nil) : .pdf(PDFBox(document: doc))
                }
            case .illustrator:
                if let doc = PDFDocument(url: url), doc.pageCount > 0, !IllustratorStub.isStub(pageText: doc.page(at: 0)?.string) {
                    return .canvas(CanvasBoard.boards(of: doc), pixels: nil)
                }
                if let cached = IllustratorRender.cached(for: url) { return .canvas(cached, pixels: nil) }
                return .illustrator(thumbnail(url))
            case .image, .svg:
                if let (image, px) = image(url) {
                    return .canvas([CanvasBoard.board(image: image, pixels: px, name: url.lastPathComponent)], pixels: px == .zero ? nil : px)
                }
            case .quickLook, .other, .canvas: return .quickLook(url)  // a canvas never gets here: its page is CanvasViewerPage
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

/// PDFKit with continuous scroll and a page-thumbnail sidebar; its page switcher and zoom live in the shared toolbar row.
@MainActor @Observable
private final class PDFController: ViewerControlling {
    @ObservationIgnored let view = PDFView()
    private(set) var page = 1
    private(set) var scale = 1.0
    let count: Int

    var switcher: (index: Int, count: Int)? { (page - 1, count) }
    var zoomLevel: Double? { scale }

    init(document: PDFDocument) {
        count = document.pageCount
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.displaysPageBreaks = true
        view.autoScales = true
        view.document = document
        scale = Double(view.scaleFactor)
    }

    func pageChanged() {
        guard let doc = view.document, let current = view.currentPage else { return }
        page = doc.index(for: current) + 1
    }
    func scaleChanged() { scale = Double(view.scaleFactor) }

    func zoomStep(in zoomIn: Bool) {
        view.autoScales = false
        let f: CGFloat = zoomIn ? 1.25 : 1 / 1.25
        view.scaleFactor = min(max(view.scaleFactor * f, view.minScaleFactor), min(view.maxScaleFactor, 8))
        scaleChanged()
    }
    func fit() { view.autoScales = true; scaleChanged() }
    func step(_ by: Int) {
        guard let doc = view.document, let p = doc.page(at: min(max(page - 1 + by, 0), count - 1)) else { return }
        view.go(to: p)
    }
}

private struct ArtifactPDFViewer: View {
    let controller: PDFController

    var body: some View {
        HStack(spacing: 0) {
            if controller.count > 1 {
                PDFThumbnails(pdfView: controller.view).frame(width: 128)
                Rectangle().fill(Theme.line).frame(width: 1)
            }
            PDFHost(view: controller.view)
        }
        .onReceive(NotificationCenter.default.publisher(for: .PDFViewPageChanged, object: controller.view)) { _ in controller.pageChanged() }
        .onReceive(NotificationCenter.default.publisher(for: .PDFViewScaleChanged, object: controller.view)) { _ in controller.scaleChanged() }
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
