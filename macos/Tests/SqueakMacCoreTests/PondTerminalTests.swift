import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondTerminalTests {
    let disk: (String) -> Bool = { ["/p/repo", "/p/folder"].contains($0) }

    @Test func gitPondOpensInItsProjectRoot() {
        #expect(PondTerminal.availability(nativeRoot: "/p/repo/", directoryFolder: nil, isDirectory: disk) == .available(folder: "/p/repo"))
    }

    @Test func folderPondOpensInItsFolder() {
        #expect(PondTerminal.availability(nativeRoot: nil, directoryFolder: "/p/folder", isDirectory: disk) == .available(folder: "/p/folder"))
    }

    @Test func missingNativeRootFallsBackToTheDirectory() {
        #expect(PondTerminal.availability(nativeRoot: "/gone", directoryFolder: "/p/folder", isDirectory: disk).folder == "/p/folder")
    }

    @Test func noFolderSaysSo() {
        #expect(PondTerminal.availability(nativeRoot: "", directoryFolder: nil, isDirectory: disk) == .unavailable(reason: PondTerminal.noFolder))
        #expect(PondTerminal.noFolder.contains("this pond has no folder on this Mac"))
    }

    @Test func podStripShowsTerminalTabsSelected() {
        let a = UUID(), b = UUID()
        let s = InspectorStrip.make(context: .pond, record: InspectorTabsRecord(open: [.files]), terminals: [a, b], selectedTerminal: b)
        #expect(s.tabs == [.pond, .artifacts, .files, .terminal(a), .terminal(b)])
        #expect(s.selected == .terminal(b))
        #expect(s.isClosable(.terminal(a)) && s.isPinned(.pond))
    }
}
