import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// The canvas viewer: a canvas opened as a tab of its pond's chat strip (an artifact of kind canvas). Left, a slim list
// of the artboards; right, the pasteboard (the artifact canvas viewer's scroll view, so pan and zoom are the same);
// above, one compact line with the tools. Clicking a board makes it live for hand editing (`CanvasEditor`); ducks change
// the same files and the open canvas redraws. A remote pond's canvas is the owner's copy, unpacked here: view and export only.

struct CanvasViewerPage: View {
    let pond: String
    let path: String
    var sidebarHidden = false
    var inspectorOpen = false
    /// The body of an artifact tab: the chat's own header and strip are above, so there is no header or back control.
    var embedded = false
    /// A remote pond's canvas, unpacked into a folder on this Mac: drawn and exported, never edited.
    var fixed: CanvasDetail?
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
            let m = CanvasModel(path: path, host: model.nativeHost, readOnly: fixed != nil, fixed: fixed)
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
            if let canvas, !canvas.readOnly { EditTools(editor: canvas.editor, pickImage: pickImage) }
            if canvas?.readOnly == true { Text("View only").font(Typo.meta).foregroundStyle(Theme.subtle) }
            if embedded { Text(verbatim: meta).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail).layoutPriority(-1) }
            if let canvas, !canvas.readOnly { EditNote(editor: canvas.editor) }
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
            if canvas?.readOnly != true {
                Button { model.askDuck(pond: pond, prefill: CanvasBoards.askPrefill(title: title)) } label: {
                    HStack(spacing: 4) { Lucide(.messageSquare, size: 13, color: Theme.ink); Text("Ask a duck\u{2026}") }
                }
                .buttonStyle(CompactToolStyle()).help("Ask the pond\u{2019}s duck to change this canvas").accessibilityLabel("Ask a duck about this canvas")
                ToolIcon(.folder, help: "Reveal in Finder") { NSWorkspace.shared.activateFileViewerSelecting([url]) }
                ArtifactCopyPath(path: path)
            }
        }
        .padding(.horizontal, Space.m).frame(height: 36)
    }

    private func pickImage() {
        guard let editor = canvas?.editor else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.title = "Add a picture"
        panel.prompt = "Add"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in editor.insertImage(url) }
        }
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
                VStack(spacing: Space.s) {
                    message(canvas.readOnly ? "This canvas has no artboards." : "This canvas has no artboards yet. Add one, or ask a duck.")
                    if !canvas.readOnly {
                        Button("Add artboard") { Task { await canvas.manage(.add(name: nil, width: nil, height: nil)) } }.buttonStyle(SecondaryButtonStyle())
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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

/// A canvas of a remote pond: the owner's Mac sends it as one bundle file (through the pond, like any artifact); it is
/// unpacked into a folder here and drawn by the same viewer, view and export only.
struct RemoteCanvasViewer: View {
    let pond: String
    /// The owner's wire id of the canvas (never a path).
    let id: String
    var sidebarHidden = false
    var inspectorOpen = false
    var embedded = false
    @Environment(AppModel.self) private var model
    @State private var phase: Phase = .loading(nil)
    @State private var attempt = 0

    private enum Phase: Equatable { case loading(Double?), failed(String), ready(CanvasDetail) }
    private var ownerMac: String { PondsModel.shared.chrome(key: pond).ownerMac }

    var body: some View {
        Group {
            switch phase {
            case .ready(let detail):
                CanvasViewerPage(pond: pond, path: detail.path, sidebarHidden: sidebarHidden, inspectorOpen: inspectorOpen, embedded: embedded, fixed: detail)
                    .id(detail.path)
            case .loading(let progress):
                status(RemoteArtifacts.downloading(progress), retry: false)
            case .failed(let why):
                status(why, retry: true)
            }
        }
        .task(id: "\(id)#\(attempt)") { await load() }
    }

    private func status(_ text: String, retry: Bool) -> some View {
        VStack(spacing: Space.s) {
            Text(verbatim: text).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            if retry { Button("Try again") { attempt += 1 }.buttonStyle(SecondaryButtonStyle()) }
        }
        .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
    }

    private func load() async {
        phase = .loading(nil)
        guard let pondId = PondsModel.shared.pond(key: pond)?.id else { phase = .failed("This pond is not available."); return }
        do {
            let answer = try await RemoteArtifacts.waitForFile(
                PondsClient(host: model.nativeHost), pond: pondId, id: id, progress: { p in Task { @MainActor in if case .loading = phase { phase = .loading(p) } } })
            switch answer {
            case .failed(let why): phase = .failed(why)
            case .pending: phase = .failed(RemoteArtifacts.offline(ownerMac))
            case .ready(let file):
                let detail = try await Task.detached(priority: .userInitiated) {
                    try CanvasBundle.unpack(try Data(contentsOf: URL(fileURLWithPath: file.path)), into: CanvasBundle.folder(forBundle: file.path))
                }.value
                phase = .ready(detail)
            }
        } catch is CancellationError {
        } catch {
            phase = .failed("Squeak couldn\u{2019}t open this canvas.")
        }
    }
}

private struct CanvasPasteboardHost: NSViewRepresentable {
    let view: CanvasScrollView
    func makeNSView(context: Context) -> CanvasScrollView { view }
    func updateNSView(_ v: CanvasScrollView, context: Context) {}
}

/// The tools line: Select, Text, Rectangle, Image, then Undo and Redo for the board being edited.
private struct EditTools: View {
    let editor: CanvasEditor
    let pickImage: () -> Void

    var body: some View {
        HStack(spacing: Space.xs) {
            ToolToggle(symbol: "cursorarrow", help: "Select (Esc)", on: editor.tool == .select && editor.boardID != nil) { editor.setTool(.select) }
            ToolToggle(symbol: "textformat", help: "Text: click the artboard to add some", on: editor.tool == .text) { editor.setTool(.text) }
            ToolToggle(symbol: "rectangle", help: "Rectangle: click or drag on the artboard", on: editor.tool == .rect) { editor.setTool(.rect) }
            ToolToggle(symbol: "photo", help: "Picture\u{2026}", on: false, action: pickImage)
            Rectangle().fill(Theme.line).frame(width: 1, height: 14).padding(.horizontal, 2)
            ToolToggle(symbol: "arrow.uturn.backward", help: "Undo (\u{2318}Z)", on: false) { editor.undo() }.disabled(!editor.canUndo)
            ToolToggle(symbol: "arrow.uturn.forward", help: "Redo (\u{21E7}\u{2318}Z)", on: false) { editor.redo() }.disabled(!editor.canRedo)
        }
    }
}

private struct ToolToggle: View {
    let symbol: String
    let help: String
    let on: Bool
    let action: () -> Void
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).frame(width: 24, height: 24)
                .background(on ? Theme.selectedStrong : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                .opacity(isEnabled ? 1 : 0.5)
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(help).accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// What the person should know about the live board: a duck changed it while they edited, or a save failed.
private struct EditNote: View {
    let editor: CanvasEditor

    var body: some View {
        if let note = editor.note {
            HStack(spacing: Space.xs) {
                Text(verbatim: note + " \u{00B7}").font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                Button("Reload") { editor.reloadFromDuck() }.buttonStyle(QuietButtonStyle()).help("Show the duck\u{2019}s version; Undo brings yours back")
                Button { editor.dismissNote() } label: { Image(systemName: "xmark").font(.system(size: 9)).foregroundStyle(Theme.subtle) }
                    .buttonStyle(.plain).accessibilityLabel("Dismiss")
            }
        } else if editor.saveFailed {
            Text("Couldn\u{2019}t save. Squeak will try again with your next change.").font(Typo.meta).foregroundStyle(Theme.negative).lineLimit(1)
        }
    }
}

/// The slim artboard list: a thumbnail and a name per artboard; a click scrolls the pasteboard to it. Rows drag to
/// reorder, "+" adds an artboard at one of the canvas kind's sizes, a right-click renames, duplicates or deletes.
private struct ArtboardList: View {
    let canvas: CanvasModel
    let boards: [CanvasArtboardInfo]
    @State private var renaming: CanvasArtboardInfo?
    @State private var newName = ""

    var body: some View {
        let current = canvas.pasteboard.index
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if !canvas.readOnly { header }
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: Space.xs) {
                            ForEach(Array(boards.enumerated()), id: \.element.id) { i, b in
                                rowButton(b, index: i, selected: i == current)
                            }
                        }
                        .padding(Space.s)
                    }
                    .scrollIndicators(.hidden)
                    .onChange(of: current) { _, now in if boards.indices.contains(now) { withAnimation(Motion.quick) { proxy.scrollTo(boards[now].id) } } }
                }
                if let notice = canvas.notice {
                    Text(verbatim: notice).font(Typo.meta).foregroundStyle(Theme.negative).padding(Space.s).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(width: 148)
            Rectangle().fill(Theme.line).frame(width: 1)
        }
        .background(Theme.bg)
        .alert("Rename artboard", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Rename") {
                if let b = renaming, !newName.trimmingCharacters(in: .whitespaces).isEmpty { Task { await canvas.manage(.rename(id: b.id, name: newName)) } }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    private var header: some View {
        HStack {
            Text("Artboards").font(Typo.meta).foregroundStyle(Theme.subtle)
            Spacer(minLength: 0)
            Menu {
                ForEach(ArtboardPresets.presets(for: canvas.detail?.kind ?? .blank)) { p in
                    Button("\(p.name)  \u{00B7}  \(p.detail)") { add(p) }
                }
            } label: { Image(systemName: "plus").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 22, height: 22).contentShape(Rectangle()) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("Add an artboard").accessibilityLabel("Add an artboard")
        }
        .padding(.horizontal, Space.s).padding(.top, Space.xs).frame(height: 28)
    }

    private func add(_ p: ArtboardPresets.Preset) {
        Task {
            if await canvas.manage(.add(name: nil, width: p.width, height: p.height)) {
                canvas.pasteboard.go(to: max(0, (canvas.detail?.artboards.count ?? 1) - 1))
            }
        }
    }

    @ViewBuilder private func rowButton(_ b: CanvasArtboardInfo, index i: Int, selected: Bool) -> some View {
        let button = Button { canvas.pasteboard.go(to: i) } label: { row(b, index: i, selected: selected) }
            .buttonStyle(.plain).id(b.id)
            .accessibilityLabel("Artboard \(i + 1), \(b.name)")
        if canvas.readOnly {
            button
        } else {
            button
                .draggable(b.id)
                .dropDestination(for: String.self) { ids, _ in
                    guard let from = ids.first.flatMap({ id in boards.firstIndex { $0.id == id } }), from != i else { return false }
                    canvas.reorder(CanvasOrder.moved(boards.map(\.id), from: from, to: from < i ? i + 1 : i))
                    return true
                }
                .contextMenu {
                    Button(ArtboardMenu.rename) { newName = b.name; renaming = b }
                    Button(ArtboardMenu.duplicate) { Task { await canvas.manage(.duplicate(id: b.id)) } }
                    Divider()
                    Button(ArtboardMenu.delete, role: .destructive) { Task { await canvas.manage(.delete(id: b.id)) } }
                        .disabled(!ArtboardMenu.canDelete(count: boards.count))
                }
        }
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
