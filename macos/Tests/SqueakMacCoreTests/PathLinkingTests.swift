import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Path linking")
struct PathLinkingTests {
    @Test func readsAPathWithAndWithoutALine() {
        #expect(PathLinking.parse("src/a.ts") == PathRef(path: "src/a.ts"))
        #expect(PathLinking.parse("src/a.ts:12") == PathRef(path: "src/a.ts", line: 12))
        #expect(PathLinking.parse("src/a.ts:12:3") == PathRef(path: "src/a.ts", line: 12))
        #expect(PathLinking.parse("~/notes.md") == PathRef(path: "~/notes.md"))
        #expect(PathLinking.parse("/tmp/shot.png") == PathRef(path: "/tmp/shot.png"))
        #expect(PathLinking.parse("README.md") == PathRef(path: "README.md"))
        for no in ["hello", "two words.md", "https://x.dev/a.png", "", "/", "a:b"] { #expect(PathLinking.parse(no) == nil, "\(no)") }
    }

    @Test func resolvesAgainstTheChatFolderAndHome() {
        let cwd = "/Users/me/work/app"
        #expect(PathLinking.resolve(PathRef(path: "src/a.ts"), cwd: cwd).path == "/Users/me/work/app/src/a.ts")
        #expect(PathLinking.resolve(PathRef(path: "../b/c.png"), cwd: cwd).path == "/Users/me/work/b/c.png")
        #expect(PathLinking.resolve(PathRef(path: "~/x.md"), cwd: cwd, home: "/Users/me").path == "/Users/me/x.md")
        #expect(PathLinking.resolve(PathRef(path: "/etc/hosts"), cwd: cwd).path == "/etc/hosts")
        #expect(PathLinking.relative(URL(fileURLWithPath: "/Users/me/work/app/src/a.ts"), to: cwd) == "src/a.ts")
        #expect(PathLinking.relative(URL(fileURLWithPath: "/tmp/x.png"), to: cwd) == nil)
    }

    @Test func aMissingPathStaysPlainAndAnExistingOneLinksOnceChecked() {
        let dir = NSTemporaryDirectory() + "pl-\(UUID().uuidString)"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: dir + "/a.txt", contents: Data("x".utf8))
        let cache = PathExistenceCache()
        let here = URL(fileURLWithPath: dir + "/a.txt"), gone = URL(fileURLWithPath: dir + "/nope.txt")
        #expect(cache.state(for: here) == .unknown)  // never reads the disk on the asking thread
        cache.drain()
        #expect(cache.state(for: here) == .exists(isDirectory: false))
        #expect(cache.state(for: URL(fileURLWithPath: dir)) == .unknown)
        _ = cache.state(for: gone); cache.drain()
        #expect(cache.state(for: gone) == .missing)
    }

    @Test func theCacheRechecksAfterItsTimeAndSaysWhenAnAnswerChanged() {
        nonisolated(unsafe) var exists = false
        nonisolated(unsafe) var clock = Date(timeIntervalSince1970: 1000)
        nonisolated(unsafe) var changes = 0
        let cache = PathExistenceCache(ttl: 10, now: { clock }, probe: { _ in exists ? (false, 1) : nil })
        cache.onChange = { changes += 1 }
        let url = URL(fileURLWithPath: "/x/y.txt")
        _ = cache.state(for: url); cache.drain()
        #expect(cache.state(for: url) == .missing)
        #expect(changes == 0)  // a first "missing" draws nothing new
        exists = true
        _ = cache.state(for: url); cache.drain()
        #expect(cache.state(for: url) == .missing)  // inside its time: not rechecked
        clock = clock.addingTimeInterval(11)
        _ = cache.state(for: url); cache.drain()
        #expect(cache.state(for: url) == .exists(isDirectory: false))
        #expect(changes == 1)
    }

    @Test func clickRoutingForEachAction() {
        let cwd = "/w/app"
        let inside = URL(fileURLWithPath: "/w/app/src/a.ts"), shot = URL(fileURLWithPath: "/tmp/s.png"), pdf = URL(fileURLWithPath: "/tmp/d.pdf")
        func fx(_ a: PathLinking.Action, _ u: URL, dir: Bool = false, line: Int? = nil) -> PathLinking.Effect {
            PathLinking.effect(for: a, url: u, state: .exists(isDirectory: dir), line: line, cwd: cwd)
        }
        #expect(fx(.openInTab, inside, line: 12) == .open(.file(inside, relative: "src/a.ts", line: 12)))
        #expect(fx(.openInTab, shot) == .open(.image(shot, relative: nil)))
        #expect(fx(.openInTab, pdf) == .open(.image(pdf, relative: nil)))
        let notes = URL(fileURLWithPath: "/tmp/notes.txt")
        #expect(fx(.openInTab, notes, line: 3) == .open(.file(notes, relative: nil, line: 3)))
        let src = URL(fileURLWithPath: "/w/app/src")
        #expect(fx(.openInTab, src, dir: true) == .open(.folder(src, relative: "src")))
        #expect(PathLinking.effect(for: .openInTab, url: inside, state: .missing, line: nil, cwd: cwd) == .open(.notFound(name: "a.ts")))
        #expect(fx(.openDefault, inside) == .openDefault(inside))
        #expect(fx(.showInFinder, inside) == .reveal(inside))
        #expect(fx(.copyPath, inside) == .copy("/w/app/src/a.ts"))
        #expect(fx(.copyRelativePath, inside) == .copy("src/a.ts"))
        #expect(fx(.copyRelativePath, shot) == .copy("/tmp/s.png"))
    }

    @Test func aLinkCarriesTheTextAsWritten() {
        let url = PathLinking.linkURL(for: "src/a b.ts:12")
        #expect(url.flatMap(PathLinking.raw(from:)) == "src/a b.ts:12")
        #expect(PathLinking.raw(from: URL(string: "https://x.dev")!) == nil)
    }

    @Test func commandPathsAreTheOnesWithASlash() {
        #expect(PathLinking.paths(inCommand: "cp ./a.png /tmp/b.png && echo \"hi\" > out.txt") == ["./a.png", "/tmp/b.png"])
    }

    @Test func aThumbnailKeyChangesWithTheFileAndTheSize() {
        let a = ThumbnailKey(path: "/p.png", modified: 1, size: 10, maxPixel: 384)
        #expect(a == ThumbnailKey(path: "/p.png", modified: 1, size: 10, maxPixel: 384))
        #expect(a != ThumbnailKey(path: "/p.png", modified: 2, size: 10, maxPixel: 384))
        #expect(a != ThumbnailKey(path: "/p.png", modified: 1, size: 11, maxPixel: 384))
        #expect(a != ThumbnailKey(path: "/p.png", modified: 1, size: 10, maxPixel: 720))
        #expect(a.string != ThumbnailKey(path: "/p.png", modified: 2, size: 10, maxPixel: 384).string)
    }

    @Test func theThumbnailCacheDecodesOncePerFileState() throws {
        let path = NSTemporaryDirectory() + "t-\(UUID().uuidString).png"
        // A 1x1 PNG.
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        try png.write(to: URL(fileURLWithPath: path))
        let cache = ThumbnailCache()
        let url = URL(fileURLWithPath: path)
        #expect(cache.latestImage(path: path, maxPixel: 96) == nil)
        #expect(cache.image(for: url, maxPixel: 96) != nil)
        #expect(cache.image(for: url, maxPixel: 96) != nil)
        #expect(cache.decodes == 1)
        #expect(cache.latestImage(path: path, maxPixel: 96) != nil)
        #expect(cache.image(for: URL(fileURLWithPath: path + ".missing"), maxPixel: 96) == nil)
    }

    @Test func zoomStepsAndFit() {
        #expect(ImageZoom.zoomedIn(1) == 1.5)
        #expect(ImageZoom.zoomedOut(1) == 0.75)
        #expect(ImageZoom.zoomedIn(0.3) == 0.5)
        #expect(ImageZoom.zoomedOut(0.1) == 0.1)
        #expect(ImageZoom.fit(image: (2000, 1000), box: (500, 500)) == 0.25)
        #expect(ImageZoom.fit(image: (100, 100), box: (500, 500)) == 1)
    }

    @Test func aStepThatReadsOrWritesAnImageGetsAThumbnailDetailAndShowImageAnImageCard() {
        func r(_ seq: Int, _ kind: String, _ json: String) -> NativeMessage {
            NativeMessage(seq: seq, role: "agent", kind: kind, payload: NativeJSON.parse(json)!, createdAt: Date(timeIntervalSince1970: 1_800_000_000 + Double(seq)))
        }
        let rows = [
            r(1, "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"/w/shot.png"}},{"type":"tool_use","id":"b","name":"Read","input":{"file_path":"/w/src/a.ts"}},{"type":"tool_use","id":"c","name":"Write","input":{"file_path":"/w/out.jpg","content":""}}]}}"#),
            r(2, "system/squeak/image", "{}"),
            r(3, "squeak/image", #"{"path":"/w/chart.png","name":"chart.png","caption":"Q3 revenue"}"#),
        ]
        let m = NativeTranscript.map(rows)
        #expect(m.details["a"] == .image(path: "/w/shot.png", caption: nil, card: false))
        #expect(m.details["b"] == .file(path: "/w/src/a.ts"))
        #expect(m.details["c"] == .image(path: "/w/out.jpg", caption: nil, card: false))
        let card = m.steps.first { $0.text == "Show image chart.png" }
        #expect(card?.detail == .image(path: "/w/chart.png", caption: "Q3 revenue", card: true))
        #expect(ToolDetail.image(path: "/x.png", caption: nil, card: true).expands == false)
        #expect(ToolDetail.file(path: "/x").expands == false)
    }

    @Test func copyingAMessageGivesThePlainPath() {
        // A link is a URL attribute on the same characters: nothing is inserted into the text.
        let raw = "src/a.ts:12"
        #expect(PathLinking.parse(raw)?.path == "src/a.ts")
        #expect(!raw.contains("\u{200B}") && PathLinking.parse("src/\u{200B}a.ts") == nil)
    }
}
