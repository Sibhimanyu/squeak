import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PathRoutingTests {
    let cwd = "/w/app"
    func dest(_ path: String, _ state: PathExistenceCache.State = .exists(isDirectory: false), line: Int? = nil) -> PathDestination {
        PathRouting.destination(url: URL(fileURLWithPath: path), state: state, line: line, cwd: cwd)
    }

    @Test func textInsideAndOutside() {
        #expect(dest("/w/app/src/a.swift", line: 42) == .file(URL(fileURLWithPath: "/w/app/src/a.swift"), relative: "src/a.swift", line: 42))
        let out = dest("/etc/hosts")
        #expect(out == .file(URL(fileURLWithPath: "/etc/hosts"), relative: nil, line: nil))
        #expect(out.isOutside)
        #expect(!dest("/w/app/a.txt").isOutside)
    }

    @Test func aSiblingFolderWithTheSamePrefixIsOutside() {
        #expect(PathRouting.inside(URL(fileURLWithPath: "/w/app2/a.txt"), root: cwd) == nil)
        #expect(PathRouting.inside(URL(fileURLWithPath: "/w/app/../app2/a"), root: cwd) == nil)
        #expect(PathRouting.inside(URL(fileURLWithPath: "/w/app/x/../a"), root: cwd) == "a")
    }

    @Test func foldersAndTheRoot() {
        #expect(dest("/w/app/src", .exists(isDirectory: true)) == .folder(URL(fileURLWithPath: "/w/app/src"), relative: "src"))
        #expect(dest("/w/app", .exists(isDirectory: true)) == .folder(URL(fileURLWithPath: "/w/app"), relative: ""))
        #expect(dest("/var/log", .exists(isDirectory: true)).isOutside)
    }

    @Test func imagesOpenInTheViewerWhereverTheyAre() {
        #expect(dest("/tmp/shot.PNG") == .image(URL(fileURLWithPath: "/tmp/shot.PNG"), relative: nil))
        #expect(dest("/w/app/a.jpg") == .image(URL(fileURLWithPath: "/w/app/a.jpg"), relative: "a.jpg"))
    }

    @Test func missingOpensNothing() {
        #expect(dest("/w/app/gone.ts", .missing) == .notFound(name: "gone.ts"))
        #expect(dest("/w/app/gone.ts", .missing).url == nil)
    }

    @Test func binaryFilesGoToAPreview() {
        #expect(PathRouting.viewer(name: "a.mp4", size: 10, head: Data([0, 1, 2])) == .preview)
        #expect(PathRouting.viewer(name: "a.zip", size: 10, head: Data([0x50, 0x4b, 0, 0])) == .preview)
        #expect(PathRouting.viewer(name: "a.txt", size: 10, head: Data("hello".utf8)) == .text)
        #expect(PathRouting.viewer(name: "big.log", size: 3 * 1024 * 1024, head: Data("x".utf8)) == .preview)
        #expect(PathRouting.viewer(name: "a.png", size: 10, head: Data([0])) == .image)
    }

    @Test func lineSuffixes() {
        #expect(PathLinking.parse("src/a.swift:42") == PathRef(path: "src/a.swift", line: 42))
        #expect(PathLinking.parse("src/a.swift:42:7") == PathRef(path: "src/a.swift", line: 42))
        #expect(PathRouting.line(0) == nil)
        #expect(PathRouting.line(9) == 9)
    }

    @Test func messageLinks() {
        #expect(PathRouting.pathText(fromLink: URL(string: "file:///tmp/a%20b.txt")!) == "/tmp/a b.txt")
        #expect(PathRouting.pathText(fromLink: URL(string: "src/a.ts")!) == "src/a.ts")
        #expect(PathRouting.pathText(fromLink: URL(string: "https://example.com/a.ts")!) == nil)
        #expect(PathRouting.pathText(fromLink: URL(string: "squeak://open?s=1")!) == nil)
        #expect(PathRouting.pathText(fromLink: URL(string: "mailto:a@b.c")!) == nil)
    }
}
