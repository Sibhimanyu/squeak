import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The canvas viewer: a canvas opened as a tab of its pond's chat strip (an artifact of kind canvas). Left, a slim list
// of the artboards; right, the pasteboard (the artifact canvas viewer's scroll view, so pan and zoom are the same);
// above, one compact line. Phase 1 has no hand editing: ducks change the files and the open canvas redraws.

struct CanvasViewerPage: View {
    let pond: String
    let path: String
    var sidebarHidden = false
    var inspectorOpen = false
    /// The body of an artifact tab: the chat's own header and strip are above, so there is no header or back control.
    var embedded = false
    @Environment(AppModel.self) private var model
    @State private var canvas: CanvasModel?

    var body: some View {
        VStack(spacing: 0) {
            if !embedded { header }
            toolbar
            Rectangle().fill(Theme.line).frame(height: 1)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: path) {
            let m = CanvasModel(path: path, host: model.nativeHost)
            canvas = m
            m.start()
        }
        .onDisappear { canvas?.stop() }
    }

    private var title: String { canvas?.title ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension }

    private var header: some View {
        HStack(spacing: Space.s) {
            if sidebarHidden { Color.clear.frame(width: PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size + WorkbenchNavigation.reserve - Space.l) }
            Button { model.closeArtifact() } label: {
                Lucide(.arrowLeft, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Back").accessibilityLabel("Close the canvas")
            Lucide(.layers, size: 15, color: Theme.muted)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: title).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                Text(verbatim: meta).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: Space.m)
            if !inspectorOpen { Color.clear.frame(width: PaneToggle.size) }
        }
        .padding(.leading, Space.l).padding(.trailing, Space.m)
        .frame(height: Metrics.header)
        .background(WindowDragArea())
    }

    private var meta: String {
        guard let d = canvas?.detail else { return "Canvas" }
        return [d.kind.menuTitle, CanvasBoards.countText(d.artboards.count)].joined(separator: " \u{00B7} ")
    }

    // MARK: Toolbar

    private var toolbar: some View {
        let board = canvas?.pasteboard
        let url = URL(fileURLWithPath: path)
        return HStack(spacing: Space.s) {
            if let board, let sw = board.switcher, ArtifactSwitcher.shown(count: sw.count) {
                ToolIcon(.chevronLeft, help: "Previous artboard") { board.step(-1) }.disabled(sw.index == 0)
                Text(verbatim: ArtifactSwitcher.text(index: sw.index, count: sw.count)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                ToolIcon(.chevronRight, help: "Next artboard") { board.step(1) }.disabled(sw.index >= sw.count - 1)
            }
            if embedded { Text(verbatim: meta).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail) }
            exportStatus
            Spacer(minLength: 0)
            if let board, let z = board.zoomLevel {
                ToolIcon(.minus, help: "Zoom out (\u{2318}-)") { board.zoomStep(in: false) }
                Text(verbatim: CanvasZoom.percentText(z)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted).frame(minWidth: 38)
                ToolIcon(.plus, help: "Zoom in (\u{2318}+)") { board.zoomStep(in: true) }
                Button("Fit") { board.fit() }.buttonStyle(CompactToolStyle()).help("Fit everything (\u{2318}0)")
                Rectangle().fill(Theme.line).frame(width: 1, height: 14).padding(.horizontal, 2)
            }
            exportMenu
            Button { model.askDuck(pond: pond, prefill: CanvasBoards.askPrefill(title: title)) } label: {
                HStack(spacing: 4) { Lucide(.messageSquare, size: 13, color: Theme.ink); Text("Ask a duck\u{2026}") }
            }
            .buttonStyle(CompactToolStyle()).help("Ask the pond\u{2019}s duck to change this canvas").accessibilityLabel("Ask a duck about this canvas")
            ToolIcon(.folder, help: "Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
            ArtifactCopyPath(path: path)
        }
        .padding(.horizontal, Space.m).frame(height: 36)
    }

    private var exportMenu: some View {
        let busy: Bool = { if case .running = canvas?.export { true } else { false } }()
        let empty = canvas?.detail?.artboards.isEmpty ?? true
        return Menu {
            Button("PDF, all artboards\u{2026}") { canvas?.exportPDF() }
            Divider()
            Button("This artboard as PNG at 1x\u{2026}") { canvas?.exportPNG(scale: .one, all: false) }
            Button("This artboard as PNG at 2x\u{2026}") { canvas?.exportPNG(scale: .two, all: false) }
            Button("All artboards as PNG at 1x\u{2026}") { canvas?.exportPNG(scale: .one, all: true) }
            Button("All artboards as PNG at 2x\u{2026}") { canvas?.exportPNG(scale: .two, all: true) }
        } label: {
            HStack(spacing: 4) { Text("Export"); Lucide(.chevronDown, size: 11, color: Theme.ink) }
        }
        .menuStyle(.button).buttonStyle(CompactToolStyle()).menuIndicator(.hidden).fixedSize()
        .disabled(busy || empty).help("Export as PDF or PNG").accessibilityLabel("Export")
    }

    @ViewBuilder private var exportStatus: some View {
        switch canvas?.export {
        case .running(let done, let total)?:
            HStack(spacing: Space.s) {
                ProgressView(value: Double(done), total: Double(max(total, 1))).frame(width: 72).controlSize(.small)
                Text(verbatim: CanvasExport.progressText(done: done, total: total)).font(Typo.meta).foregroundStyle(Theme.muted)
            }
        case .finished(let url)?:
            HStack(spacing: Space.s) {
                Text("Exported").font(Typo.meta).foregroundStyle(Theme.muted)
                Button("Reveal") { NSWorkspace.shared.activateFileViewerSelecting([url]) }.buttonStyle(QuietButtonStyle())
            }
        case .failed(let why)?:
            Text(verbatim: why).font(Typo.meta).foregroundStyle(Theme.negative).lineLimit(1)
        default:
            EmptyView()
        }
    }

    // MARK: Body

    @ViewBuilder private var content: some View {
        if let canvas {
            if let why = canvas.failure {
                message(why)
            } else if let d = canvas.detail, d.artboards.isEmpty {
                message("This canvas has no artboards yet. Ask a duck to add some.")
            } else {
                HStack(spacing: 0) {
                    if let d = canvas.detail, d.artboards.count > 0 { ArtboardList(canvas: canvas, boards: d.artboards) }
                    CanvasPasteboardHost(view: canvas.pasteboard.view)
                }
            }
        } else {
            Text("Opening\u{2026}").font(Typo.body).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func message(_ text: String) -> some View {
        Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct CanvasPasteboardHost: NSViewRepresentable {
    let view: CanvasScrollView
    func makeNSView(context: Context) -> CanvasScrollView { view }
    func updateNSView(_ v: CanvasScrollView, context: Context) {}
}

/// The slim artboard list: a thumbnail and a name per artboard; a click scrolls the pasteboard to it.
private struct ArtboardList: View {
    let canvas: CanvasModel
    let boards: [CanvasArtboardInfo]

    var body: some View {
        let current = canvas.pasteboard.index
        HStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: Space.xs) {
                        ForEach(Array(boards.enumerated()), id: \.element.id) { i, b in
                            Button { canvas.pasteboard.go(to: i) } label: { row(b, index: i, selected: i == current) }
                                .buttonStyle(.plain).id(b.id)
                                .accessibilityLabel("Artboard \(i + 1), \(b.name)")
                        }
                    }
                    .padding(Space.s)
                }
                .scrollIndicators(.hidden)
                .onChange(of: current) { _, now in if boards.indices.contains(now) { withAnimation(Motion.quick) { proxy.scrollTo(boards[now].id) } } }
            }
            .frame(width: 148)
            Rectangle().fill(Theme.line).frame(width: 1)
        }
        .background(Theme.bg)
    }

    private func row(_ b: CanvasArtboardInfo, index: Int, selected: Bool) -> some View {
        VStack(spacing: 4) {
            Group {
                if let image = canvas.images[b.id] {
                    Image(nsImage: image).resizable().scaledToFit()
                } else {
                    Color.white.aspectRatio(b.width / max(b.height, 1), contentMode: .fit)
                }
            }
            .frame(maxWidth: 124, maxHeight: 84)
            .overlay(Rectangle().strokeBorder(Theme.line))
            HStack(spacing: 4) {
                Text(verbatim: "\(index + 1)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                Text(verbatim: b.name).font(Typo.meta).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1).truncationMode(.tail)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Space.xs)
        .background(selected ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.row))
        .contentShape(Rectangle())
    }
}
