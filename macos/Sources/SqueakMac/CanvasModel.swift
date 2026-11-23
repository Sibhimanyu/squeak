import AppKit
import SqueakMacCore

// One open canvas: the host's detail of it, the picture of each artboard, and the pasteboard that shows them. The host
// pushes `changed` when a file in the folder changes (a duck rewrote slide 4); only artboards whose stamp moved are
// drawn again, one at a time, and the open pasteboard keeps its zoom and place while they swap in.

@MainActor @Observable
final class CanvasPasteboard: ViewerControlling {
    private(set) var index = 0
    private(set) var zoomValue = 1.0
    private(set) var count = 0
    private(set) var frames: [CGRect] = []
    @ObservationIgnored let view = CanvasScrollView(boards: [], frames: [])
    @ObservationIgnored private var hadBoards = false

    var switcher: (index: Int, count: Int)? { count > 0 ? (index, count) : nil }
    var zoomLevel: Double? { count > 0 ? zoomValue : nil }

    init() {
        view.onChange = { [weak self] zoom, nearest in
            guard let self else { return }
            if zoom != zoomValue { zoomValue = zoom }
            if let nearest, nearest != index { index = nearest }
        }
    }

    func show(_ boards: [CanvasBoard]) {
        let placed = ArtboardLayout.place(boards.map(\.size))
        frames = placed
        count = boards.count
        if index >= boards.count { index = max(0, boards.count - 1) }
        view.update(boards: boards, frames: placed, alwaysLabel: true, refit: !hadBoards && !boards.isEmpty)
        if !boards.isEmpty { hadBoards = true }
    }

    func step(_ by: Int) { go(to: ArtifactSwitcher.stepped(index, by: by, count: count)) }
    func go(to i: Int) {
        guard let f = CanvasBoards.frame(at: i, in: frames) else { return }
        index = i
        view.scrollTo(worldRect: f)
    }
    func zoomStep(in zoomIn: Bool) { view.zoomStep(in: zoomIn) }
    func fit() { view.fitAll() }
}

@MainActor @Observable
final class CanvasModel {
    enum Export: Equatable {
        case idle
        case running(done: Int, total: Int)
        case finished(URL)
        case failed(String)
    }

    let path: String
    private(set) var detail: CanvasDetail?
    private(set) var failure: String?
    private(set) var images: [String: NSImage] = [:]
    private(set) var export: Export = .idle
    let pasteboard = CanvasPasteboard()

    @ObservationIgnored private let host: NativeHostClient
    @ObservationIgnored private var drawn: [String: CanvasBoards.Stamp] = [:]
    @ObservationIgnored private var pumping = false
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var follow: Task<Void, Never>?
    @ObservationIgnored private var exporting: Task<Void, Never>?

    init(path: String, host: NativeHostClient) { self.path = path; self.host = host }

    var root: URL { URL(fileURLWithPath: path) }
    var title: String { detail?.title ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension }

    /// Reads now, then again on every push from the host.
    func start() {
        stopped = false
        follow?.cancel()
        follow = Task { [weak self] in
            await self?.reload()
            guard let host = self?.host, let path = self?.path else { return }
            for await _ in host.canvasEvents(path: path) {
                guard !Task.isCancelled else { return }
                await self?.reload()
            }
        }
    }

    func stop() {
        stopped = true
        follow?.cancel(); follow = nil
        exporting?.cancel(); exporting = nil
    }

    private func reload() async {
        do {
            let d = try await host.canvasDetail(path: path)
            guard !stopped else { return }
            failure = nil
            if d != detail { detail = d }
            drawn = CanvasBoards.pruned(drawn: drawn, detail: d)
            images = images.filter { id, _ in d.artboards.contains { $0.id == id } }
            present()
            pump()
        } catch {
            if detail == nil { failure = "Squeak couldn\u{2019}t open this canvas." }
        }
    }

    /// The pasteboard from what is known: each artboard's picture, or "Rendering…" until it has one.
    private func present() {
        guard let d = detail else { return }
        let boards = d.artboards.enumerated().map { i, a in
            CanvasBoard(
                name: ArtboardLayout.label(name: a.name, index: i), size: a.size,
                art: .image(images[a.id] ?? CanvasRender.placeholder(size: a.size, text: "Rendering\u{2026}")))
        }
        pasteboard.show(boards)
    }

    /// Draws stale artboards one after another; the next is chosen from the latest detail each time, so a change that
    /// lands mid-way is picked up and a board that vanished is skipped.
    private func pump() {
        guard !pumping else { return }
        pumping = true
        Task { [weak self] in
            while let self, !self.stopped, let d = self.detail,
                let id = CanvasBoards.needingRender(drawn: self.drawn, detail: d).first,
                let board = d.artboards.first(where: { $0.id == id }) {
                let stamp = CanvasBoards.Stamp(board, assetsModifiedAt: d.assetsModifiedAt)
                do {
                    self.images[id] = try await CanvasRender.image(board: board, root: self.root)
                } catch {
                    self.images[id] = CanvasRender.placeholder(size: board.size, text: "Couldn\u{2019}t draw this artboard")
                }
                self.drawn[id] = stamp
                self.present()
            }
            self?.pumping = false
        }
    }

    // MARK: Export

    func exportPDF() {
        guard let d = detail, !d.artboards.isEmpty else { return }
        savePanel(name: CanvasExport.pdfName(canvas: d.title), folder: false) { [self] url in
            run(total: d.artboards.count) { [self] progress in
                var pages: [Data] = []
                for (i, b) in d.artboards.enumerated() {
                    progress(i)
                    pages.append(try await CanvasRender.pdfPage(board: b, root: root))
                }
                progress(d.artboards.count)
                let merged = await Task.detached { CanvasRender.merge(pages) }.value
                guard let merged else { throw CanvasRenderError.pdfFailed }
                try await Task.detached { try merged.write(to: url, options: .atomic) }.value
                return url
            }
        }
    }

    func exportPNG(scale: CanvasExport.Scale, all: Bool) {
        guard let d = detail, !d.artboards.isEmpty else { return }
        let targets = CanvasExport.targets(all: all, selected: pasteboard.index, count: d.artboards.count)
        let single = targets.count == 1 && !all
        let first = d.artboards[targets[0]]
        let name = single
            ? CanvasExport.pngName(canvas: d.title, board: first.name, index: targets[0], count: d.artboards.count, scale: scale)
            : CanvasExport.folderName(canvas: d.title)
        savePanel(name: name, folder: !single) { [self] url in
            run(total: targets.count) { [self] progress in
                if !single { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true) }
                for (n, i) in targets.enumerated() {
                    progress(n)
                    let b = d.artboards[i]
                    let data = try await CanvasRender.png(board: b, root: root, scale: scale)
                    let file = single ? url : url.appending(path: CanvasExport.pngName(canvas: d.title, board: b.name, index: i, count: d.artboards.count, scale: scale))
                    try await Task.detached { try data.write(to: file, options: .atomic) }.value
                }
                progress(targets.count)
                return url
            }
        }
    }

    private func savePanel(name: String, folder: Bool, then: @escaping @MainActor (URL) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.canCreateDirectories = true
        panel.title = folder ? "Export artboards" : "Export"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in then(url) }
        }
    }

    private func run(total: Int, _ work: @escaping @MainActor (@MainActor (Int) -> Void) async throws -> URL) {
        exporting?.cancel()
        export = .running(done: 0, total: total)
        exporting = Task { [weak self] in
            do {
                let url = try await work { done in self?.export = .running(done: done, total: total) }
                self?.export = .finished(url)
                try? await Task.sleep(for: .seconds(8))
                if case .finished = self?.export { self?.export = .idle }
            } catch is CancellationError {
                self?.export = .idle
            } catch {
                self?.export = .failed("Squeak couldn\u{2019}t export this canvas.")
            }
        }
    }
}
