import AppKit
import PDFKit
import SqueakIcons
import SqueakMacCore
import SwiftUI
import WebKit

// The Artifacts tab (right zone beside a pond page): what the pond's ducks made for the person to look at, grouped by
// duck, newest first. A click opens a preview in the tab (pages, pictures, PDF, Photoshop and Illustrator files drawn
// with the viewers the file tab already uses); each row can open in the default app, reveal in Finder, and copy its
// path. The list is the host's (`GET /native/projects/<id>/artifacts`); the rules are in `Ponds/Artifacts.swift`.

@MainActor @Observable
final class ArtifactsModel {
    private(set) var items: [ArtifactItem] = []
    private(set) var loaded = false
    private(set) var failed = false
    private var projectId = ""
    private var task: Task<Void, Never>?

    /// Reads now and again every few seconds (the host answers from a cache), so a duck's new `show` appears at once.
    func follow(_ id: String, host: NativeHostClient) {
        if id != projectId { items = []; loaded = false; failed = false }
        projectId = id
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let rows = try await host.artifacts(projectId: id)
                    guard let self, self.projectId == id else { return }
                    if rows != self.items { self.items = rows }
                    self.loaded = true; self.failed = false
                } catch {
                    self?.failed = true; self?.loaded = true
                }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    func stop() { task?.cancel(); task = nil }
}

struct ArtifactsTab: View {
    let projectId: String
    @Environment(AppModel.self) private var model
    @State private var feed = ArtifactsModel()
    @State private var open: ArtifactItem?

    var body: some View {
        Group {
            if let open {
                ArtifactDetail(item: open) { self.open = nil }
            } else {
                list
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task(id: projectId) { feed.follow(projectId, host: model.nativeHost) }
        .onDisappear { feed.stop() }
    }

    @ViewBuilder private var list: some View {
        let groups = Artifacts.grouped(feed.items)
        if groups.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text(feed.loaded ? "Nothing to look at yet." : "Looking for artifacts…").font(Typo.heading).foregroundStyle(Theme.ink)
                if feed.loaded {
                    Text(feed.failed
                         ? "Squeak couldn't read this pond's artifacts."
                         : "Pages a duck opens, and design files (PSD, AI, PDF, SVG, images) in the pond's folders, show up here.")
                        .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
            Spacer(minLength: 0)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: Space.m, pinnedViews: []) {
                    ForEach(groups) { group in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: group.title).font(Typo.meta).foregroundStyle(Theme.subtle)
                                .padding(.horizontal, Space.s).padding(.bottom, 2)
                            ForEach(group.items) { item in ArtifactRow(item: item) { open = item } }
                        }
                    }
                }
                .padding(Space.s)
            }
        }
    }
}

extension ArtifactKind {
    var lucide: LucideName {
        switch self {
        case .page: .globe
        case .doc: .fileText
        case .image: .image
        case .pdf, .other: .file
        case .psd: .layers
        case .ai: .palette
        case .svg: .penTool
        }
    }
}

private enum ArtifactActions {
    static func openDefault(_ item: ArtifactItem) { NSWorkspace.shared.open(URL(fileURLWithPath: item.path)) }
    static func reveal(_ item: ArtifactItem) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.path)]) }
}

private struct ArtifactRow: View {
    let item: ArtifactItem
    let select: () -> Void
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        HStack(spacing: Space.s) {
            Lucide(item.kind.lucide, size: 16, color: Theme.muted).frame(width: 20)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: item.name).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text(verbatim: Artifacts.meta(item)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 4)
            if hovering {
                iconButton(.externalLink, Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }
                iconButton(.folder, "Reveal in Finder") { ArtifactActions.reveal(item) }
            }
            Button(copied ? "Copied" : "Copy") { copy() }
                .buttonStyle(QuietButtonStyle()).help("Copy path").accessibilityLabel("Copy path of \(item.name)")
        }
        .padding(.horizontal, Space.s).padding(.vertical, 5)
        .background(hovering ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.row))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .onTapGesture(perform: select)
        .contextMenu {
            Button(Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }
            Button("Reveal in Finder") { ArtifactActions.reveal(item) }
            Button("Copy path") { copy() }
        }
        .accessibilityElement(children: .combine).accessibilityAddTraits(.isButton)
        .accessibilityLabel("\(item.name), \(Artifacts.meta(item))")
    }

    private func iconButton(_ name: LucideName, _ help: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Lucide(name, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
            .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.path, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
}

// MARK: Preview

private struct ArtifactDetail: View {
    let item: ArtifactItem
    let back: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Button(action: back) { Lucide(.arrowLeft, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle()) }
                    .buttonStyle(.plain).help("Back to the list").accessibilityLabel("Back to artifacts")
                Lucide(item.kind.lucide, size: 14, color: Theme.muted)
                Text(verbatim: item.name).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
            }
            .padding(.horizontal, Space.s).frame(height: 36)
            HStack(spacing: Space.s) {
                Button(Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }.buttonStyle(SecondaryButtonStyle())
                Button("Reveal in Finder") { ArtifactActions.reveal(item) }.buttonStyle(QuietButtonStyle())
                CopyButton(text: item.path)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, Space.s).padding(.bottom, Space.s)
            Rectangle().fill(Theme.line).frame(height: 1)
            ArtifactPreviewView(item: item).id(item.path)
        }
    }
}

/// What is read off the disk for a preview, off the main thread.
private enum ArtifactContent {
    case web(URL), markdown(String, URL), image(NSImage), pdf(PDFDocument), quickLook(URL), icon
}

private struct ArtifactPreviewView: View {
    let item: ArtifactItem
    @State private var content: ArtifactContent?

    var body: some View {
        Group {
            switch content {
            case nil: Color.clear
            case .web(let url): ArtifactWebPage(url: url)
            case .markdown(let text, let url): MarkdownFilePreview(text: text, fileURL: url, root: url.deletingLastPathComponent())
            case .image(let image): ImageCanvas(image: image, name: item.name)
            case .pdf(let doc): ArtifactPDF(document: doc)
            case .quickLook(let url): QuickLookPreview(url: url)
            case .icon: icon
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
        .task(id: item.path) { content = await Self.load(item) }
    }

    /// The icon of an Illustrator file with no PDF inside (or any file nothing can draw), and how to open it.
    private var icon: some View {
        VStack(spacing: Space.m) {
            Image(nsImage: NSWorkspace.shared.icon(forFile: item.path)).resizable().frame(width: 96, height: 96)
            Text(verbatim: item.name).font(Typo.heading).foregroundStyle(Theme.ink)
            Text(Artifacts.openAppName(item.kind) == nil ? "Squeak can't draw this file." : "Squeak can't draw this file. \(Artifacts.openLabel(item.kind)).")
                .font(Typo.body).foregroundStyle(Theme.muted)
            Button(Artifacts.openLabel(item.kind)) { ArtifactActions.openDefault(item) }.buttonStyle(SecondaryButtonStyle())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static func load(_ item: ArtifactItem) async -> ArtifactContent {
        let url = URL(fileURLWithPath: item.path)
        var choice: ArtifactPreview? = ArtifactPreview.choose(kind: item.kind, path: item.path)
        while let c = choice {
            switch c {
            case .web: return .web(url)
            case .markdown:
                let text = await Task.detached { try? String(contentsOf: url, encoding: .utf8) }.value
                if let text { return .markdown(text, url) }
            case .image:
                let image = await Task.detached { NSImage(contentsOf: url) }.value
                if let image, image.isValid { return .image(image) }
            case .pdf:
                let doc = PDFDocument(url: url)  // lazy: pages are read as they scroll in
                if let doc, doc.pageCount > 0 { return .pdf(doc) }
            case .quickLook:
                return item.kind == .ai ? .icon : .quickLook(url)
            }
            choice = ArtifactPreview.fallback(after: c, kind: item.kind)
        }
        return .icon
    }
}

private struct ArtifactPDF: NSViewRepresentable {
    let document: PDFDocument
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true; v.displayMode = .singlePageContinuous; v.document = document
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) { if v.document !== document { v.document = document } }
}

/// An HTML page a duck wrote, drawn as a page. It may read its own folder (images, styles) and nothing else.
private struct ArtifactWebPage: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        v.setValue(false, forKey: "drawsBackground")
        v.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {}
}
