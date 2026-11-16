import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Shown files")
struct ShownFileTests {
    let now = Date(timeIntervalSince1970: 1_000_000)

    @Test func opensOnlyFreshRowsOnce() {
        #expect(ShownFile.shouldAutoOpen(shownAt: now.addingTimeInterval(-3), now: now, alreadyOpened: false))
        #expect(!ShownFile.shouldAutoOpen(shownAt: now.addingTimeInterval(-3), now: now, alreadyOpened: true))
        #expect(!ShownFile.shouldAutoOpen(shownAt: now.addingTimeInterval(-3600), now: now, alreadyOpened: false))
        #expect(!ShownFile.shouldAutoOpen(shownAt: now.addingTimeInterval(600), now: now, alreadyOpened: false))
    }

    @Test func showDetailNamesItsFile() {
        let d = ToolDetail.shown(path: "/w/out/page.html", at: now)
        #expect(d.path == "/w/out/page.html")
        #expect(!d.expands)
    }
}
