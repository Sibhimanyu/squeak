import Testing
@testable import SqueakMacCore

@Suite struct PondFilterTests {
    let all = [
        PondFilter.Entry(name: "newest", labels: ["work"]),
        PondFilter.Entry(name: "quiet", hidden: true, labels: ["Work", "oss"]),
        PondFilter.Entry(name: "mid", labels: ["oss"]),
        PondFilter.Entry(name: "oldest", hidden: true),
    ]

    @Test func hiddenLeaveTheListAndAreCounted() {
        let r = PondFilter.apply(all, label: nil, showHidden: false)
        #expect(r.names == ["newest", "mid"])
        #expect(r.hiddenCount == 2)
    }

    @Test func showHiddenKeepsNewestFirstOrder() {
        let r = PondFilter.apply(all, label: nil, showHidden: true)
        #expect(r.names == ["newest", "quiet", "mid", "oldest"])
        #expect(r.hiddenCount == 0)
    }

    @Test func labelNarrowsCaseInsensitivelyAndCountsOnlyItsHidden() {
        let r = PondFilter.apply(all, label: "work", showHidden: false)
        #expect(r.names == ["newest"])
        #expect(r.hiddenCount == 1)
        #expect(PondFilter.apply(all, label: "WORK", showHidden: true).names == ["newest", "quiet"])
        #expect(PondFilter.apply(all, label: "nothing", showHidden: true).names.isEmpty)
    }

    @Test func labelRules() {
        #expect(PondFilter.clean("  a ") == "a")
        #expect(PondFilter.clean("   ") == nil)
        #expect(PondFilter.clean(String(repeating: "x", count: 25)) == nil)
        #expect(PondFilter.clean(String(repeating: "x", count: 24)) != nil)
        #expect(PondFilter.adding("Work", to: ["work"]) == ["work"])
        #expect(PondFilter.adding("new", to: ["a"]) == ["a", "new"])
        let eight = (1...8).map { "l\($0)" }
        #expect(PondFilter.adding("ninth", to: eight) == nil)
    }

    @Test func countsMergeCases() {
        let c = PondFilter.counts(all)
        #expect(c.map(\.label) == ["oss", "work"])
        #expect(c.map(\.count) == [2, 2])
    }
}

@Suite struct PondColoursTests {
    @Test func paletteMatchesTheHost() {
        let host: [(String, Double)] = [("red", 355), ("coral", 10), ("lime", 95), ("green", 140), ("teal", 175), ("cyan", 195),
                                        ("blue", 220), ("indigo", 245), ("violet", 270), ("purple", 295), ("pink", 325)]
        #expect(PondColours.all.map(\.name) == host.map(\.0))
        #expect(PondColours.all.map(\.hue) == host.map(\.1))
        #expect(PondColours.hue(named: "teal") == 175)
        #expect(PondColours.hue(named: nil) == nil)
    }
}
