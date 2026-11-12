import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct PondSlimTests {
    let now = Date(timeIntervalSince1970: 1_000_000)

    @Test func metaLine() {
        let done = PondMeta.line(agentName: "Claude", model: "Opus 5.5", state: .finished, startedAt: nil, lastActivityAt: now.addingTimeInterval(-101 * 60), now: now)
        #expect(done == "Claude \u{00B7} Opus 5.5 \u{00B7} finished 1 h 41 min ago")
        #expect(PondMeta.line(agentName: "Codex", model: nil, state: .working, startedAt: now.addingTimeInterval(-720), lastActivityAt: nil, now: now) == "Codex \u{00B7} working for 12 min")
        #expect(PondMeta.line(agentName: "Claude", model: nil, state: .blocked, startedAt: nil, lastActivityAt: nil, now: now) == "Claude \u{00B7} waiting on you")
        let other = PondMeta.line(agentName: "Claude", model: nil, state: .blocked, startedAt: nil, lastActivityAt: nil, now: now, startedBy: "Aarav", runsOn: "Aarav's Mac")
        #expect(other.hasSuffix("started by Aarav \u{00B7} runs on Aarav's Mac"))
    }

    @Test func strip() {
        #expect(PondMeta.strip(files: 68, added: 9770, removed: 1172) == "68 files \u{00B7} +9770 \u{2212}1172")
        #expect(PondMeta.strip(files: 1, added: 1, removed: 0) == "1 file \u{00B7} +1 \u{2212}0")
        #expect(PondMeta.strip(files: 0, added: 0, removed: 0) == nil)
    }

    @Test func faces() {
        #expect(PondFaces.overflow(total: 2).more == 0)
        let o = PondFaces.overflow(total: 8)
        #expect(o.shown == 5 && o.more == 3)
        #expect(PondFaces.rows(total: 5) == (3, 2))
        #expect(!PondFaces.showsList(peopleOtherThanYou: 0) && PondFaces.showsList(peopleOtherThanYou: 1))
        #expect(PondFaces.tooltip(name: "Aarav", role: "Owner", online: true) == "Aarav \u{00B7} Owner \u{00B7} online")
        #expect(PondFaces.tooltip(name: "Claude", role: nil, online: nil) == "Claude")
    }

    @Test func activityFilter() {
        func r(_ id: String, _ k: PondRipple.Kind, _ s: String) -> PondRipple { PondRipple(id: id, kind: k, sentence: s, at: now, threadKey: nil) }
        let all = [
            r("a", .finished, "Fix finished"), r("b", .remote, "Aarav started Fix"), r("c", .remote, "Aarav joined"),
            r("d", .remote, "Squeak changed 3 files"), r("e", .remote, "The pond key was changed"), r("f", .prMerged, "PR #4 merged from Fix"),
        ]
        #expect(PondActivity.filter(all).map(\.id) == ["c", "e", "f"])
        #expect(PondActivity.label(count: 3) == "Activity \u{00B7} 3" && PondActivity.label(count: 0) == "Activity")
    }
}
