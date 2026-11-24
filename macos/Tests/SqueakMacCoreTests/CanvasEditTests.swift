import XCTest
@testable import SqueakMacCore

final class CanvasEditTests: XCTestCase {
    // MARK: Undo and redo

    func testHistoryStepsBackAndForwardAndDropsRedoOnANewChange() {
        var h = EditHistory(initial: "a")
        XCTAssertFalse(h.canUndo); XCTAssertNil(h.undo())
        h.record("b"); h.record("c")
        XCTAssertEqual(h.current, "c")
        XCTAssertEqual(h.undo(), "b"); XCTAssertEqual(h.undo(), "a"); XCTAssertNil(h.undo())
        XCTAssertTrue(h.canRedo)
        XCTAssertEqual(h.redo(), "b")
        h.record("x")
        XCTAssertFalse(h.canRedo)
        XCTAssertEqual(h.states, ["a", "b", "x"])
        XCTAssertNil(h.redo())
    }

    func testHistoryIgnoresARepeatedStateAndCapsItsSteps() {
        var h = EditHistory(initial: "0")
        h.record("0")
        XCTAssertEqual(h.states.count, 1)
        for i in 1...(EditHistory.maxSteps + 20) { h.record("\(i)") }
        XCTAssertEqual(h.states.count, EditHistory.maxSteps)
        XCTAssertEqual(h.current, "\(EditHistory.maxSteps + 20)")
        // Undo reaches the oldest kept state, never past it.
        var steps = 0
        while h.undo() != nil { steps += 1 }
        XCTAssertEqual(steps, EditHistory.maxSteps - 1)
        h.reset(to: "fresh")
        XCTAssertEqual(h.states, ["fresh"]); XCTAssertFalse(h.canUndo)
    }

    // MARK: A duck editing while the person does

    func testMergeDecisionFollowsWhoChangedWhat() {
        XCTAssertEqual(EditMerge.decide(mineChanged: false, conflicts: []), .adopt)
        XCTAssertEqual(EditMerge.decide(mineChanged: false, conflicts: ["a"]), .adopt)
        XCTAssertEqual(EditMerge.decide(mineChanged: true, conflicts: []), .merge)
        XCTAssertEqual(EditMerge.decide(mineChanged: true, conflicts: ["a", "b"]), .keepMine(["a", "b"]))
    }

    func testOwnWritesAreNotADucksChange() {
        let known: Set<Int64> = [100, 250]
        XCTAssertFalse(EditMerge.isExternal(stamp: 250, known: known))
        XCTAssertTrue(EditMerge.isExternal(stamp: 251, known: known))
        XCTAssertEqual(EditMerge.note, "A duck changed this artboard")
    }

    // MARK: Artboard list

    func testPresetsStartWithTheKindsOwnSize() {
        XCTAssertEqual(ArtboardPresets.presets(for: .deck).first?.width, 1920)
        XCTAssertEqual(ArtboardPresets.presets(for: .poster).first?.height, 1350)
        XCTAssertEqual(ArtboardPresets.presets(for: .logo).first?.width, 1024)
        XCTAssertEqual(ArtboardPresets.presets(for: .social).first?.height, 1080)
        for kind in CanvasKind.allCases {
            let all = ArtboardPresets.presets(for: kind)
            XCTAssertEqual(Set(all.map(\.id)).count, all.count)
            XCTAssertTrue(all.allSatisfy { (16...8000).contains($0.width) && (16...8000).contains($0.height) })
        }
        XCTAssertEqual(ArtboardPresets.presets(for: .deck)[0].detail, "1920 \u{00D7} 1080")
    }

    func testReorderingFollowsSwiftUIsMoveMeaning() {
        let ids = ["a", "b", "c", "d"]
        XCTAssertEqual(CanvasOrder.moved(ids, from: 0, to: 3), ["b", "c", "a", "d"])
        XCTAssertEqual(CanvasOrder.moved(ids, from: 0, to: 4), ["b", "c", "d", "a"])
        XCTAssertEqual(CanvasOrder.moved(ids, from: 3, to: 0), ["d", "a", "b", "c"])
        XCTAssertEqual(CanvasOrder.moved(ids, from: 2, to: 1), ["a", "c", "b", "d"])
        // Dropping a row where it already sits (or just after itself) changes nothing, and so does a bad index.
        XCTAssertEqual(CanvasOrder.moved(ids, from: 1, to: 1), ids)
        XCTAssertEqual(CanvasOrder.moved(ids, from: 1, to: 2), ids)
        XCTAssertEqual(CanvasOrder.moved(ids, from: 9, to: 0), ids)
        XCTAssertEqual(CanvasOrder.moved(ids, from: 0, to: 9), ids)
    }

    func testDeleteKeepsASelectionAndNeverTheLastBoard() {
        XCTAssertEqual(CanvasOrder.selectionAfterDelete(index: 1, remaining: 3), 1)
        XCTAssertEqual(CanvasOrder.selectionAfterDelete(index: 3, remaining: 3), 2)
        XCTAssertEqual(CanvasOrder.selectionAfterDelete(index: 0, remaining: 0), 0)
        XCTAssertFalse(ArtboardMenu.canDelete(count: 1))
        XCTAssertTrue(ArtboardMenu.canDelete(count: 2))
    }

    func testListOperationsBecomeTheHostsBodies() {
        XCTAssertEqual(CanvasOp.add(name: "Two", width: 1600, height: 900).body,
                       .object(["op": .string("add"), "name": .string("Two"), "width": .number(1600), "height": .number(900)]))
        XCTAssertEqual(CanvasOp.add(name: nil, width: nil, height: nil).body, .object(["op": .string("add")]))
        XCTAssertEqual(CanvasOp.rename(id: "a", name: "B").body, .object(["op": .string("rename"), "id": .string("a"), "name": .string("B")]))
        XCTAssertEqual(CanvasOp.reorder(["b", "a"]).body, .object(["op": .string("reorder"), "order": .array([.string("b"), .string("a")])]))
        XCTAssertEqual(CanvasOp.delete(id: "a").body, .object(["op": .string("delete"), "id": .string("a")]))
        XCTAssertEqual(CanvasOp.duplicate(id: "a").body, .object(["op": .string("duplicate"), "id": .string("a")]))
        XCTAssertEqual(CanvasOp.resize(id: "a", width: 5, height: 6).body,
                       .object(["op": .string("resize"), "id": .string("a"), "width": .number(5), "height": .number(6)]))
    }

    // MARK: Pictures

    func testAssetNamesAreSafeAndUnique() {
        XCTAssertTrue(CanvasAsset.isImage("/x/Photo.JPG")); XCTAssertFalse(CanvasAsset.isImage("notes.txt")); XCTAssertFalse(CanvasAsset.isImage("noext"))
        XCTAssertEqual(CanvasAsset.assetName(for: "My Photo (1).PNG", existing: []), "My-Photo-1.png")
        XCTAssertEqual(CanvasAsset.assetName(for: "a.png", existing: ["a.png"]), "a-2.png")
        XCTAssertEqual(CanvasAsset.assetName(for: "a.png", existing: ["a.png", "a-2.png"]), "a-3.png")
        XCTAssertEqual(CanvasAsset.assetName(for: "../../etc/passwd.png", existing: []), "passwd.png")
        XCTAssertEqual(CanvasAsset.assetName(for: "\u{1F600}.png", existing: []), "image.png")
        XCTAssertEqual(CanvasAsset.source(for: "a.png"), "../assets/a.png")
    }

    // MARK: Inspector

    func testSelectionMessagesDecode() {
        let body: [String: Any] = [
            "t": "selection", "tool": "select", "editing": false,
            "items": [
                ["id": "sq1", "tag": "h1", "text": true, "x": 160, "y": 380.5, "w": 1600, "h": 132, "rotation": 0, "opacity": 1,
                 "fontFamily": "-apple-system, sans-serif", "fontSize": 120, "fontWeight": "700", "color": "#111111", "textAlign": "left",
                 "lineHeight": 1.1, "background": "", "radius": 0, "borderWidth": 0, "borderColor": "#111111", "borderStyle": "none"],
                ["nope": 1],
            ],
        ]
        let items = DesignSelection.items(in: body)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0].id, "sq1")
        XCTAssertEqual(items[0].label, "Text")
        XCTAssertEqual(items[0].y, 380.5)
        XCTAssertEqual(DesignSelection.items(in: ["t": "other"]), [])
        XCTAssertEqual(DesignSelection.items(in: "junk"), [])
        XCTAssertEqual(DesignItem(tag: "img").label, "Image")
        XCTAssertEqual(DesignItem(tag: "div").label, "Shape")
    }

    func testTypedValuesParse() {
        XCTAssertEqual(DesignInput.number("12"), 12)
        XCTAssertEqual(DesignInput.number(" 12.5 px "), 12.5)
        XCTAssertEqual(DesignInput.number("1,5"), 1.5)
        XCTAssertEqual(DesignInput.number("-45\u{00B0}"), -45)
        XCTAssertEqual(DesignInput.number("80%"), 80)
        XCTAssertNil(DesignInput.number("")); XCTAssertNil(DesignInput.number("abc")); XCTAssertNil(DesignInput.number("inf"))
        XCTAssertEqual(DesignInput.hex("#ABC"), "#aabbcc")
        XCTAssertEqual(DesignInput.hex("FFDA1A"), "#ffda1a")
        XCTAssertNil(DesignInput.hex("#12")); XCTAssertNil(DesignInput.hex("red")); XCTAssertNil(DesignInput.hex("#12345g"))
        XCTAssertEqual(DesignInput.display(12), "12"); XCTAssertEqual(DesignInput.display(12.34), "12.3"); XCTAssertEqual(DesignInput.display(-0.04), "0")
        XCTAssertEqual(DesignInput.opacity(percent: 150), 1); XCTAssertEqual(DesignInput.opacity(percent: 25), 0.25); XCTAssertEqual(DesignInput.opacity(percent: -5), 0)
        XCTAssertEqual(DesignProp.fontSize.rawValue, "fontSize")
        XCTAssertEqual(DesignValue.number(3).jsonObject as? Double, 3)
    }

    func testFontsMatchBySystemAndFirstFamily() {
        XCTAssertEqual(DesignFonts.match("-apple-system, \"Helvetica Neue\", Helvetica, Arial, sans-serif")?.name, "System")
        XCTAssertEqual(DesignFonts.match("\"Times New Roman\", Times, serif")?.name, "Times New Roman")
        XCTAssertEqual(DesignFonts.match("Georgia")?.name, "Georgia")
        XCTAssertNil(DesignFonts.match("\"Inter\", sans-serif"))
        XCTAssertEqual(DesignFonts.firstFamily("\"Inter\", sans-serif"), "Inter")
        XCTAssertEqual(DesignFonts.weight("bold"), "700"); XCTAssertEqual(DesignFonts.weight("normal"), "400")
        XCTAssertEqual(DesignFonts.weight("550"), "500"); XCTAssertEqual(DesignFonts.weight("900"), "800")
        XCTAssertEqual(Set(DesignFonts.all.map(\.name)).count, DesignFonts.all.count)
    }

    // MARK: Remote canvases

    private func bundle(artboards: [[String: Any]]? = nil, html: [String: String]? = nil, assets: [String: String] = [:]) -> Data {
        let boards = artboards ?? [["id": "title", "name": "Title", "width": 1920, "height": 1080, "background": "#ffffff"]]
        let root: [String: Any] = [
            "format": CanvasBundle.format, "version": 1,
            "canvas": ["version": 1, "title": "Pitch", "kind": "deck", "artboards": boards],
            "artboards": html ?? ["title": "<p>hi</p>"], "assets": assets,
        ]
        return try! JSONSerialization.data(withJSONObject: root)
    }

    private func temp() -> URL {
        let u = FileManager.default.temporaryDirectory.appending(path: "canvas-bundle-\(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: u) }
        return u
    }

    func testUnpacksABundleIntoAFolderTheViewerCanRead() throws {
        let png = Data([1, 2, 3]).base64EncodedString()
        let dest = temp().appending(path: "pitch.canvas")
        let d = try CanvasBundle.unpack(bundle(assets: ["a.png": png, "sub/b.png": png]), into: dest)
        XCTAssertEqual(d.title, "Pitch"); XCTAssertEqual(d.kind, .deck)
        XCTAssertEqual(d.artboards.map(\.id), ["title"])
        XCTAssertEqual(d.artboards[0].file, dest.standardizedFileURL.appending(path: "artboards/title.html").path)
        XCTAssertEqual(try String(contentsOfFile: d.artboards[0].file, encoding: .utf8), "<p>hi</p>")
        XCTAssertEqual(try Data(contentsOf: dest.appending(path: "assets/sub/b.png")), Data([1, 2, 3]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dest.appending(path: "canvas.json").path))
        // Unpacking again replaces what was there.
        _ = try CanvasBundle.unpack(bundle(html: ["title": "<p>new</p>"]), into: dest)
        XCTAssertEqual(try String(contentsOf: dest.appending(path: "artboards/title.html"), encoding: .utf8), "<p>new</p>")
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.appending(path: "assets/a.png").path))
    }

    func testRefusesBundlesThatReachOutOfTheFolder() {
        let png = Data([1]).base64EncodedString()
        let dest = temp().appending(path: "x.canvas")
        for assets in [["../evil.png": png], ["/etc/x.png": png], ["a/../../b.png": png], [".hidden": png], ["a//b.png": png], ["a/b/c/d/e.png": png]] {
            XCTAssertThrowsError(try CanvasBundle.unpack(bundle(assets: assets), into: dest), "\(assets.keys)") { XCTAssertEqual($0 as? CanvasBundleError, .unsafe) }
        }
        for id in ["../x", "A", "a/b", "", "a.b"] {
            XCTAssertThrowsError(try CanvasBundle.unpack(bundle(artboards: [["id": id, "name": "n", "width": 100, "height": 100]], html: [id: "x"]), into: dest)) {
                XCTAssertEqual($0 as? CanvasBundleError, .unsafe)
            }
        }
        XCTAssertThrowsError(try CanvasBundle.unpack(bundle(artboards: [["id": "a", "name": "n", "width": 5, "height": 100]], html: ["a": "x"]), into: dest))
        XCTAssertThrowsError(try CanvasBundle.unpack(bundle(artboards: [["id": "a", "name": "n", "width": 100, "height": 100], ["id": "a", "name": "n", "width": 100, "height": 100]], html: ["a": "x"]), into: dest))
        XCTAssertThrowsError(try CanvasBundle.unpack(Data("{}".utf8), into: dest)) { XCTAssertEqual($0 as? CanvasBundleError, .notABundle) }
        XCTAssertThrowsError(try CanvasBundle.unpack(Data("nope".utf8), into: dest)) { XCTAssertEqual($0 as? CanvasBundleError, .notABundle) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: dest.deletingLastPathComponent().appending(path: "evil.png").path))
    }

    func testBundleFoldersAreStablePerFileAndEndInCanvas() {
        let t = URL(fileURLWithPath: "/tmp/t")
        let a = CanvasBundle.folder(forBundle: "/cache/p/launch.canvasbundle", temp: t)
        XCTAssertEqual(a, CanvasBundle.folder(forBundle: "/cache/p/launch.canvasbundle", temp: t))
        XCTAssertNotEqual(a, CanvasBundle.folder(forBundle: "/cache/q/launch.canvasbundle", temp: t))
        XCTAssertEqual(a.lastPathComponent, "launch.canvas")
        XCTAssertTrue(a.path.hasPrefix("/tmp/t/SqueakRemoteCanvas/"))
        XCTAssertTrue(CanvasBundle.isSafeID("slide-2")); XCTAssertFalse(CanvasBundle.isSafeID("Slide"))
    }
}
