import Foundation
import Testing
@testable import SqueakMacCore

/// A pond made a moment ago is not "gone" because the directory read the Mac holds is older than the pond: that read
/// sent the owner to the global Dashboard instead of the new pond's page or its New duck page.
@Suite struct FreshPondsTests {
    private let now = Date(timeIntervalSince1970: 1_000_000)
    private let stale: Set<String> = ["old-pond"]

    @Test func staleDirectoryWithoutTheNewPondWouldPruneIt() {
        let loc = WorkbenchLocation.compose(.newThread, pond: "new-project", workspace: nil)
        #expect(loc.prune(livePonds: stale) == .home) // the bug, before the fresh ponds are consulted
        var fresh = FreshPonds()
        fresh.add("new-project", at: now)
        let live = fresh.live(directory: stale, now: now.addingTimeInterval(5))
        #expect(loc.prune(livePonds: live) == loc)
        #expect(WorkbenchLocation.pondHome(pond: "new-project").prune(livePonds: live) == .pondHome(pond: "new-project"))
    }

    @Test func notLoadedStaysNotLoaded() {
        var fresh = FreshPonds()
        fresh.add("p", at: now)
        #expect(fresh.live(directory: nil, now: now) == nil)
    }

    @Test func graceEndsAndDirectoryDecides() {
        var fresh = FreshPonds()
        fresh.add("p", at: now)
        #expect(fresh.live(directory: stale, now: now.addingTimeInterval(FreshPonds.grace + 1)) == stale)
    }

    @Test func listedPondsAreDropped() {
        var fresh = FreshPonds()
        fresh.add("p", at: now)
        fresh.prune(listed: ["p"], now: now)
        #expect(fresh.keys(now: now).isEmpty)
    }
}
