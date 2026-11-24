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
    /// The artboard nearest the viewport changed (the person scrolled): what to draw first changes with it.
    @ObservationIgnored var onNearestChange: (() -> Void)?

    /// The viewport's centre, taken as the centre of the nearest artboard.
    var viewportCentre: CGPoint? { frames.indices.contains(index) ? CGPoint(x: frames[index].midX, y: frames[index].midY) : nil }

    var switcher: (index: Int, count: Int)? { count > 0 ? (index, count) : nil }
    var zoomLevel: Double? { count > 0 ? zoomValue : nil }

    init() {
        view.onChange = { [weak self] zoom, nearest in
            guard let self else { return }
            if zoom != zoomValue { zoomValue = zoom }
            if let nearest, nearest != index { index = nearest; onNearestChange?() }
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
    @ObservationIgnored private var running: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var stopped = false
    @ObservationIgnored private var follow: Task<Void, Never>?
    @ObservationIgnored private var exporting: Task<Void, Never>?
    /// Set when a change to the artboard list did not go through; cleared by the next one that does.
    private(set) var notice: String?
    /// A canvas that is only looked at: a remote pond's (its folder is a copy of the owner's, unpacked here).
    let readOnly: Bool
    @ObservationIgnored private let fixed: CanvasDetail?
    @ObservationIgnored lazy var editor = CanvasEditor(canvas: self, enabled: !readOnly)

    init(path: String, host: NativeHostClient, readOnly: Bool = false, fixed: CanvasDetail? = nil) {
        self.path = path; self.host = host; self.readOnly = readOnly; self.fixed = fixed
    }

    var root: URL { URL(fileURLWithPath: path) }
    var title: String { detail?.title ?? ((path as NSString).lastPathComponent as NSString).deletingPathExtension }

    /// Reads now, then again on every push from the host.
    func start() {
        stopped = false
        follow?.cancel()
        pasteboard.onNearestChange = { [weak self] in self?.pump() }
        CanvasSnapshotStore.shared.observeEvictions(path: path) { [weak self] ids in
            guard let self else { return }
            for id in ids { images[id] = nil; drawn[id] = nil }
            present()
            pump()
        }
        if !readOnly {
            pasteboard.view.onBoardClick = { [weak self] i in self?.editor.begin(index: i) }
            pasteboard.view.onBackgroundClick = { [weak self] in self?.editor.end() }
        }
        if let fixed {
            detail = fixed
            present()
            pump()
            return
        }
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
        editor.end()
        stopped = true
        follow?.cancel(); follow = nil
        exporting?.cancel(); exporting = nil
        for t in running.values { t.cancel() }
        CanvasSnapshotStore.shared.stopObserving(path: path)
    }

    private func reload() async {
        do {
            let d = try await host.canvasDetail(path: path)
            guard !stopped else { return }
            failure = nil
            take(d)
        } catch {
            if detail == nil { failure = "Squeak couldn\u{2019}t open this canvas." }
        }
    }

    /// A new detail of the canvas (the host's read, or the answer to an edit of the list).
    private func take(_ d: CanvasDetail) {
        if d != detail { detail = d }
        drawn = CanvasBoards.pruned(drawn: drawn, detail: d)
        images = images.filter { id, _ in d.artboards.contains { $0.id == id } }
        present()
        editor.boardsChanged()
        editor.detailChanged()
        pump()
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

    private func key(_ board: CanvasArtboardInfo, _ d: CanvasDetail) -> CanvasSnapshotKey {
        CanvasSnapshotKey(canvasPath: path, board: board, assetsModifiedAt: d.assetsModifiedAt)
    }

    /// Draws stale artboards, nearest the viewport first, on the pool's slots. Each one is answered from the memory or
    /// disk cache when its file is unchanged, and drawn otherwise. Re-chosen from the latest detail and viewport after
    /// every change, so a board that vanished is skipped, a change that lands mid-way is picked up, and renders for
    /// artboards the person scrolled far away from are cancelled.
    private func pump() {
        guard !stopped, let d = detail else { return }
        let store = CanvasSnapshotStore.shared
        store.retain(path: path, current: Set(d.artboards.map { key($0, d) }))
        let ids = d.artboards.map(\.id)
        var frames: [String: CGRect] = [:]
        if pasteboard.frames.count == ids.count { frames = Dictionary(uniqueKeysWithValues: zip(ids, pasteboard.frames)) }
        let order = CanvasRenderPlan.priority(ids: ids, frames: frames, centre: pasteboard.viewportCentre ?? .zero)
        let cost = Dictionary(uniqueKeysWithValues: d.artboards.map { ($0.id, key($0, d).pixelBytes) })
        let wanted = Set(CanvasRenderPlan.withinBudget(order: order, cost: cost, budget: CanvasSnapshotStore.memoryBudget))
        // The board being edited is drawn by its live page; its picture is taken when editing ends.
        let needing = Set(CanvasBoards.needingRender(drawn: drawn, detail: d)).subtracting([editor.boardID].compactMap { $0 })
        let waiting = order.filter { needing.contains($0) && wanted.contains($0) && running[$0] == nil }
        let slots = CanvasRenderPool.shared.slotCount
        for id in CanvasRenderPlan.cancellations(inFlight: Array(running.keys), waiting: waiting, order: order, keep: slots + 2) {
            running[id]?.cancel()
        }
        for id in waiting where running.count < slots {
            guard let board = d.artboards.first(where: { $0.id == id }) else { continue }
            start(board, in: d)
        }
    }

    private func start(_ board: CanvasArtboardInfo, in d: CanvasDetail) {
        let id = board.id, stamp = CanvasBoards.Stamp(board, assetsModifiedAt: d.assetsModifiedAt), key = key(board, d)
        running[id] = Task { [weak self] in
            let store = CanvasSnapshotStore.shared
            var image: NSImage?
            var cancelled = false
            if let hit = store.memory(key) {
                image = hit
            } else if let hit = await store.disk(key) {
                image = hit
            } else {
                do {
                    let drawnImage = try await CanvasRender.image(board: board, root: URL(fileURLWithPath: key.canvasPath), width: board.width * Double(key.scale))
                    store.put(drawnImage, key)
                    image = drawnImage
                } catch is CancellationError {
                    cancelled = true
                } catch {
                    image = CanvasRender.placeholder(size: board.size, text: "Couldn\u{2019}t draw this artboard")
                }
            }
            guard let self else { return }
            running[id] = nil
            if !cancelled, !Task.isCancelled, !stopped, let image {
                images[id] = image
                drawn[id] = stamp
                present()
            }
            pump()
        }
    }

    // MARK: Editing

    func saveArtboard(id: String, html: String) async throws -> Int64 { try await host.saveArtboard(path: path, id: id, html: html) }

    /// The picture of a board taken from its live page when editing ended: shown at once, and not drawn again until the
    /// file changes under someone else.
    func adopt(image: NSImage, id: String, stamp: Int64) {
        images[id] = image
        if var board = detail?.artboards.first(where: { $0.id == id }) {
            board.modifiedAt = stamp
            drawn[id] = CanvasBoards.Stamp(board, assetsModifiedAt: detail?.assetsModifiedAt ?? 0)
        }
        present()
    }

    /// Copies a picture into the canvas's `assets/` and returns its name there.
    func copyAsset(_ source: URL) async throws -> String {
        let dir = root.appending(path: "assets")
        return try await Task.detached {
            let fm = FileManager.default
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let existing = Set((try? fm.contentsOfDirectory(atPath: dir.path)) ?? [])
            let name = CanvasAsset.assetName(for: source.lastPathComponent, existing: existing)
            try fm.copyItem(at: source, to: dir.appending(path: name))
            return name
        }.value
    }

    /// An edit of the artboard list (add, rename, duplicate, delete, reorder). Returns whether the host did it.
    @discardableResult
    func manage(_ op: CanvasOp) async -> Bool {
        guard !readOnly else { return false }
        do {
            take(try await host.manageCanvas(path: path, op))
            notice = nil
            return true
        } catch {
            notice = "Squeak couldn\u{2019}t change the artboards. Try again."
            return false
        }
    }

    /// Drag-reorder: the list and the pasteboard follow at once, then the host is told.
    func reorder(_ ids: [String]) {
        guard var d = detail, !readOnly, ids.count == d.artboards.count, Set(ids) == Set(d.artboards.map(\.id)) else { return }
        let byID = Dictionary(uniqueKeysWithValues: d.artboards.map { ($0.id, $0) })
        d.artboards = ids.compactMap { byID[$0] }
        take(d)
        Task { await manage(.reorder(ids)) }
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
