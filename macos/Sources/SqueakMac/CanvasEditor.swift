import AppKit
import SqueakMacCore
import WebKit

// Hand editing of one artboard. Selecting a board swaps it from its picture to a live page (a WKWebView over it on the
// pasteboard, scaled with the zoom) running `Resources/canvas-edit.js`; the other boards stay pictures. Every committed
// change comes back as the artboard's whole HTML: it goes on the undo stack and, a moment later, to the host
// (`PUT /native/canvases/artboard`). Leaving edit mode draws the board from the live page into its picture, so nothing
// jumps. Page scripts stay off; only this script (in its own content world) runs.

/// The live page. It hands scrolling and pinching to the pasteboard so panning and zooming never stop over a board.
final class LiveBoardWebView: WKWebView {
    weak var pasteboard: CanvasScrollView?
    override var acceptsFirstResponder: Bool { true }
    override func scrollWheel(with event: NSEvent) {
        if let pasteboard { pasteboard.forwardScroll(event) } else { super.scrollWheel(with: event) }
    }
    override func magnify(with event: NSEvent) {
        if let pasteboard { pasteboard.forwardMagnify(event) } else { super.magnify(with: event) }
    }
}

@MainActor enum CanvasEditScript {
    /// The bundled script; in a dev run (no app bundle resources) the file beside this source.
    static let source: String = {
        if let url = Bundle.main.url(forResource: "canvas-edit", withExtension: "js"), let s = try? String(contentsOf: url, encoding: .utf8) { return s }
        let dev = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appending(path: "Resources/canvas-edit.js")
        return (try? String(contentsOf: dev, encoding: .utf8)) ?? ""
    }()
    static let world = WKContentWorld.world(name: "squeak-edit")
}

/// Receives the page's messages without keeping the editor alive (a content controller holds its handlers strongly).
private final class ScriptProxy: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    weak var target: CanvasEditor?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { target?.receive(body) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { target?.loadFailed() }
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { target?.loadFailed() }
    }
}

@MainActor @Observable
final class CanvasEditor {
    enum Tool: String { case select, text, rect }

    /// The artboard being edited (its id); nil when every board is a picture.
    private(set) var boardID: String?
    private(set) var selection: [DesignItem] = []
    private(set) var tool: Tool = .select
    private(set) var editingText = false
    private(set) var ready = false
    private(set) var canUndo = false
    private(set) var canRedo = false
    private(set) var saveFailed = false
    /// "A duck changed this artboard" while the person's version was kept; Reload takes the duck's.
    private(set) var note: String?

    @ObservationIgnored let enabled: Bool
    @ObservationIgnored private weak var canvas: CanvasModel?
    @ObservationIgnored private var web: LiveBoardWebView?
    @ObservationIgnored private var proxy: ScriptProxy?
    @ObservationIgnored private var history = EditHistory(initial: "")
    /// What is on screen, and what the host last got (or the page as it opened).
    @ObservationIgnored private var mine = ""
    @ObservationIgnored private var saved = ""
    @ObservationIgnored private var known = Set<Int64>()
    @ObservationIgnored private var lastStamp: Int64 = 0
    @ObservationIgnored private var pendingTheirs: String?
    @ObservationIgnored private var lastScale = 0.0
    @ObservationIgnored private var saveTimer: Task<Void, Never>?
    @ObservationIgnored private var saveChain: Task<Void, Never>?
    @ObservationIgnored private var transition: Task<Void, Never>?
    @ObservationIgnored private var merging = false

    init(canvas: CanvasModel, enabled: Bool) {
        self.canvas = canvas
        self.enabled = enabled && !CanvasEditScript.source.isEmpty
    }

    // MARK: Entering and leaving

    private func queue(_ work: @escaping @MainActor () async -> Void) {
        let prev = transition
        transition = Task { await prev?.value; await work() }
    }

    /// Makes the board at `index` live (and the one before it a picture again).
    func begin(index: Int) {
        guard enabled, let id = canvas?.detail?.artboards[safe: index]?.id, id != boardID else { return }
        queue { [weak self] in await self?.open(id: id) }
    }

    /// Leaves edit mode: saves, draws the board from the live page into its picture, removes the page.
    func end() { if boardID != nil { queue { [weak self] in await self?.close() } } }

    /// Edit mode for the board on screen now, waiting until its page is ready (a tool or a picture was chosen first).
    func ensureEditing() async -> Bool {
        guard enabled else { return false }
        if boardID == nil, let canvas { begin(index: canvas.pasteboard.index) }
        await transition?.value
        for _ in 0..<150 where !ready && boardID != nil { try? await Task.sleep(for: .milliseconds(30)) }
        return ready
    }

    private func open(id: String) async {
        if boardID == id { return }
        await close()
        guard let canvas, let board = canvas.detail?.artboards.first(where: { $0.id == id }) else { return }
        let proxy = ScriptProxy()
        proxy.target = self
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.allowsContentJavaScript = false
        config.userContentController.add(proxy, contentWorld: CanvasEditScript.world, name: "sq")
        config.userContentController.addUserScript(WKUserScript(source: CanvasEditScript.source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: CanvasEditScript.world))
        let page = LiveBoardWebView(frame: CGRect(origin: .zero, size: board.size), configuration: config)
        page.setValue(false, forKey: "drawsBackground")
        page.navigationDelegate = proxy
        page.pasteboard = canvas.pasteboard.view
        page.isHidden = true
        web = page
        self.proxy = proxy
        boardID = id
        ready = false; selection = []; tool = .select; editingText = false; note = nil; saveFailed = false
        canUndo = false; canRedo = false; pendingTheirs = nil; lastScale = 0
        known = [board.modifiedAt]; lastStamp = board.modifiedAt
        canvas.pasteboard.view.onLiveScale = { [weak self] z in self?.scaled(z) }
        canvas.pasteboard.view.onKeyCommand = { [weak self] e in self?.handleKey(e) ?? false }
        canvas.pasteboard.view.setLive(page, boardIndex: canvas.detail?.artboards.firstIndex { $0.id == id })
        CanvasDesignTab.shared.editor = self
        page.loadFileURL(URL(fileURLWithPath: board.file), allowingReadAccessTo: canvas.root)
    }

    private func close() async {
        guard let id = boardID, let page = web, let canvas else { teardown(); return }
        saveTimer?.cancel()
        if ready {
            _ = await js("SqEdit.selectNone()")
            if let html = await js("return SqEdit.serialize()") as? String, html != mine { adopt(html) }
            await flush()
            // The board's own picture, from the page the person was looking at, so the swap shows no change.
            let config = WKSnapshotConfiguration()
            config.rect = page.bounds
            if let board = canvas.detail?.artboards.first(where: { $0.id == id }) {
                config.snapshotWidth = NSNumber(value: board.width)
                config.afterScreenUpdates = true
                let image: NSImage? = await withCheckedContinuation { c in page.takeSnapshot(with: config) { image, _ in c.resume(returning: image) } }
                if let image { canvas.adopt(image: image, id: id, stamp: lastStamp) }
            }
        }
        teardown()
    }

    private func teardown() {
        if let page = web {
            page.stopLoading()
            page.configuration.userContentController.removeScriptMessageHandler(forName: "sq", contentWorld: CanvasEditScript.world)
            page.removeFromSuperview()
        }
        canvas?.pasteboard.view.setLive(nil, boardIndex: nil)
        canvas?.pasteboard.view.onLiveScale = nil
        canvas?.pasteboard.view.onKeyCommand = nil
        web = nil; proxy = nil; boardID = nil
        ready = false; selection = []; tool = .select; editingText = false; note = nil; canUndo = false; canRedo = false
        pendingTheirs = nil
        if CanvasDesignTab.shared.editor === self { CanvasDesignTab.shared.editor = nil; CanvasDesignTab.shared.shown = false }
        if let w = canvas?.pasteboard.view.window { w.makeFirstResponder(canvas?.pasteboard.view) }
    }

    func loadFailed() { end() }

    /// The board's place on the pasteboard moved (an artboard was added, removed or reordered): the page follows it, or is
    /// dropped when its board is gone.
    func boardsChanged() {
        guard let id = boardID, let canvas else { return }
        if let i = canvas.detail?.artboards.firstIndex(where: { $0.id == id }) {
            if let web { canvas.pasteboard.view.setLive(web, boardIndex: i) }
        } else {
            queue { [weak self] in self?.teardown() }
        }
    }

    // MARK: Talking to the page

    private func js(_ code: String, _ args: [String: Any] = [:]) async -> Any? {
        guard let web else { return nil }
        let body = code.contains("return ") ? code : "return \(code)"
        return try? await web.callAsyncJavaScript(body, arguments: args, in: nil, contentWorld: CanvasEditScript.world)
    }

    private func scaled(_ z: Double) {
        guard let web, z > 0, abs(z - lastScale) > 0.0005 else { return }
        lastScale = z
        web.pageZoom = CGFloat(z)
        Task { _ = await js("SqEdit.setZoom(z)", ["z": z]) }
    }

    func receive(_ body: Any) {
        guard let m = body as? [String: Any], let t = m["t"] as? String, web != nil else { return }
        switch t {
        case "ready":
            guard let html = m["html"] as? String else { return }
            mine = html; saved = html
            history = EditHistory(initial: html)
            canUndo = false; canRedo = false
            ready = true
            web?.isHidden = false
            if let web { web.window?.makeFirstResponder(web) }
            if let z = web.map({ Double($0.frame.width) / max(1, (canvas?.detail?.artboards.first { $0.id == boardID }?.width) ?? 1) }) { scaled(z) }
        case "change":
            guard let html = m["html"] as? String else { return }
            adopt(html)
            scheduleSave()
        case "selection":
            let had = !selection.isEmpty
            selection = DesignSelection.items(in: m)
            editingText = (m["editing"] as? Bool) ?? false
            if let name = m["tool"] as? String, let tool = Tool(rawValue: name) { self.tool = tool }
            if !had, !selection.isEmpty { CanvasDesignTab.shared.reveal() }
        case "tool":
            if let name = m["tool"] as? String, let tool = Tool(rawValue: name) { self.tool = tool }
        case "editing":
            editingText = (m["on"] as? Bool) ?? false
        case "escape":
            end()
        case "cmd":
            if (m["name"] as? String) == "redo" { redo() } else { undo() }
        default:
            break
        }
    }

    /// A committed change: it is the shown state, on the undo stack.
    private func adopt(_ html: String) {
        mine = html
        history.record(html)
        canUndo = history.canUndo; canRedo = history.canRedo
    }

    // MARK: Commands

    func setTool(_ t: Tool) {
        Task { [weak self] in
            guard let self, await ensureEditing() else { return }
            tool = t
            _ = await js("SqEdit.setTool(name)", ["name": t.rawValue])
        }
    }

    func apply(_ prop: DesignProp, _ value: DesignValue, soft: Bool = false) {
        Task { [weak self] in _ = await self?.js("SqEdit.setProp(name, value, soft)", ["name": prop.rawValue, "value": value.jsonObject, "soft": soft]) }
    }

    func delete() { Task { [weak self] in _ = await self?.js("SqEdit.act('delete')") } }
    func duplicate() { Task { [weak self] in _ = await self?.js("SqEdit.act('duplicate')") } }
    func deselect() { Task { [weak self] in _ = await self?.js("SqEdit.selectNone()") } }

    func undo() {
        guard let html = history.undo() else { return }
        show(html)
    }

    func redo() {
        guard let html = history.redo() else { return }
        show(html)
    }

    /// Puts a step of the history on screen and saves it.
    private func show(_ html: String) {
        mine = html
        canUndo = history.canUndo; canRedo = history.canRedo
        Task { [weak self] in
            _ = await self?.js("SqEdit.restore(html)", ["html": html])
            self?.scheduleSave()
        }
    }

    /// ⌘Z, ⇧⌘Z and ⌘D while the page is live and no text is being typed (the page undoes its own typing).
    private func handleKey(_ event: NSEvent) -> Bool {
        guard boardID != nil, ready, !editingText else { return false }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "z": if event.modifierFlags.contains(.shift) { redo() } else { undo() }; return true
        case "d": if selection.isEmpty { return false }; duplicate(); return true
        default: return false
        }
    }

    /// A picture from disk: copied into the canvas's `assets/` and placed on the board, centred.
    func insertImage(_ url: URL) {
        Task { [weak self] in
            guard let self, let canvas, await ensureEditing() else { return }
            guard let name = try? await canvas.copyAsset(url) else { return }
            let size = Self.pixels(of: url)
            _ = await js("SqEdit.insertImage(src, w, h)", ["src": CanvasAsset.source(for: name), "w": size.width, "h": size.height])
        }
    }

    private static func pixels(of url: URL) -> CGSize {
        if let rep = NSImageRep(contentsOf: url), rep.pixelsWide > 0, rep.pixelsHigh > 0 { return CGSize(width: rep.pixelsWide, height: rep.pixelsHigh) }
        if let image = NSImage(contentsOf: url), image.size.width > 0 { return image.size }
        return CGSize(width: 600, height: 400)
    }

    // MARK: Saving

    private func scheduleSave() {
        saveTimer?.cancel()
        saveTimer = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await self?.flush()
        }
    }

    /// Writes what is on screen to the host, one write at a time, until it has the latest.
    private func flush() async {
        saveTimer?.cancel(); saveTimer = nil
        let prev = saveChain
        let step = Task { [weak self] in
            await prev?.value
            await self?.writeOnce()
        }
        saveChain = step
        await step.value
    }

    private func writeOnce() async {
        guard let canvas, let id = boardID, mine != saved else { return }
        let html = mine
        do {
            let stamp = try await canvas.saveArtboard(id: id, html: html)
            known.insert(stamp); lastStamp = stamp > 0 ? stamp : lastStamp
            saved = html
            saveFailed = false
        } catch {
            saveFailed = true
        }
        if mine != saved, !saveFailed { await writeOnce() }
    }

    // MARK: A duck changing the board meanwhile

    /// The host reported the canvas changed: if the edited board's file is someone else's write, work out whose version
    /// stays (`EditMerge`): the duck's when nothing was changed here, a merge when each touched other elements, the
    /// person's (with a note and Reload) when both touched the same.
    func detailChanged() {
        guard let id = boardID, ready, !merging, let canvas, let board = canvas.detail?.artboards.first(where: { $0.id == id }),
              EditMerge.isExternal(stamp: board.modifiedAt, known: known) else { return }
        merging = true
        known.insert(board.modifiedAt)
        let file = board.file
        Task { [weak self] in
            defer { self?.merging = false }
            guard let theirs = await Task.detached(operation: { try? String(contentsOfFile: file, encoding: .utf8) }).value else { return }
            await self?.resolve(theirs: theirs, board: board.id)
        }
    }

    private func resolve(theirs: String, board: String) async {
        guard boardID == board, ready else { return }
        guard let r = await js("SqEdit.merge(base, mine, theirs)", ["base": saved, "mine": mine, "theirs": theirs]) as? [String: Any],
              let html = r["html"] as? String else { return }
        let conflicts = (r["conflicts"] as? [String]) ?? []
        let mineChanged = !((r["mineChanged"] as? [Any]) ?? []).isEmpty
        switch EditMerge.decide(mineChanged: mineChanged, conflicts: conflicts) {
        case .adopt:
            if let shown = await js("SqEdit.restore(html)", ["html": html]) as? String { adopt(shown); saved = shown }
            note = nil
        case .merge:
            if let shown = await js("SqEdit.restore(html)", ["html": html]) as? String { adopt(shown) }
            saved = ""  // the merge is not on disk yet: save it
            scheduleSave()
        case .keepMine:
            pendingTheirs = theirs
            note = EditMerge.note
        }
    }

    /// "Reload": take the duck's version of the board (still one undo step away).
    func reloadFromDuck() {
        guard let theirs = pendingTheirs else { note = nil; return }
        pendingTheirs = nil; note = nil
        Task { [weak self] in
            if let shown = await self?.js("SqEdit.restore(html)", ["html": theirs]) as? String { self?.adopt(shown); self?.saved = shown }
        }
    }

    func dismissNote() { note = nil }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
