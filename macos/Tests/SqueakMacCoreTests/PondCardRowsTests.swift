import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct PondCardRowsTests {
    private func row(_ id: String, _ state: PondThreadState = .finished, mark: ChatMark? = nil) -> PondChatRow {
        PondChatRow(id: id, title: id, state: state, mark: mark, local: nil, pondThread: id, people: [])
    }
    private func ids(_ r: (rows: [PondChatRow], hiddenCount: Int)) -> [String] { r.rows.map(\.id) }

    @Test func noActiveShowsNewestThree() {
        let t = (1...6).map { row("t\($0)") }
        let r = PondCardRows.visible(threads: t, expanded: false)
        #expect(ids(r) == ["t1", "t2", "t3"]); #expect(r.hiddenCount == 3)
    }

    @Test func fiveActiveShowsAllFive() {
        let t = (1...5).map { row("a\($0)", .working) } + [row("f1"), row("f2")]
        let r = PondCardRows.visible(threads: t, expanded: false)
        #expect(ids(r) == ["a1", "a2", "a3", "a4", "a5"]); #expect(r.hiddenCount == 2)
    }

    @Test func olderActiveKeepsItsPlace() {
        let t = [row("f1"), row("f2"), row("w", .working), row("f3"), row("f4")]
        let r = PondCardRows.visible(threads: t, expanded: false)
        #expect(ids(r) == ["f1", "f2", "w"]); #expect(r.hiddenCount == 2)
    }

    @Test func exactlyThreeHasNoFooter() {
        let r = PondCardRows.visible(threads: [row("a"), row("b"), row("c")], expanded: false)
        #expect(r.rows.count == 3); #expect(r.hiddenCount == 0)
    }

    @Test func expandedShowsAll() {
        let t = (1...6).map { row("t\($0)") }
        let r = PondCardRows.visible(threads: t, expanded: true)
        #expect(r.rows.count == 6); #expect(r.hiddenCount == 0)
    }

    @Test func unreadAndFailedAreActive() {
        let t = [row("f1"), row("f2"), row("f3"), row("u", mark: ChatMark(.unread)), row("x", .failed), row("f4")]
        let r = PondCardRows.visible(threads: t, expanded: false)
        #expect(ids(r) == ["f1", "u", "x"]); #expect(r.hiddenCount == 3)
    }

    @Test func threadBecomingActiveAppears() {
        var t = (1...6).map { row("t\($0)") }
        #expect(!ids(PondCardRows.visible(threads: t, expanded: false)).contains("t5"))
        t[4] = row("t5", .working)
        #expect(ids(PondCardRows.visible(threads: t, expanded: false)) == ["t1", "t2", "t5"])
    }
}
