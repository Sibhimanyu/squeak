import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct RoomFoldTests {
    func status(_ id: String, duck: String, kind: RoomStatusLine.Kind = .took, text: String = "x") -> RoomItem {
        .system(RoomSystemLine(
            id: id, at: 1, text: text, jobId: nil, buttons: [], opens: duck,
            status: RoomStatusLine(kind: kind, sessionId: duck, name: duck, summary: text)))
    }
    func person(_ id: String) -> RoomItem {
        .group(RoomMessageGroup(author: .me, messages: [RoomMessage(id: id, at: 1, author: .me, parts: [.text("hi", .normal)])]))
    }
    func line(_ item: RoomItem) -> RoomSystemLine? { if case .system(let s) = item { s } else { nil } }

    @Test func aRunOfOneDucksLinesBecomesOneRowShowingTheLatest() {
        let out = RoomFold.fold([
            status("a", duck: "pip", kind: .took, text: "took"), status("b", duck: "pip", kind: .done, text: "finished"),
            status("c", duck: "pip", kind: .done, text: "latest"),
        ])
        #expect(out.count == 1)
        let l = line(out[0])
        #expect(l?.status?.summary == "latest")
        #expect(l?.earlier.map(\.id) == ["a", "b"])
        // the row keeps the run's first id, so a growing run never replaces it
        #expect(l?.id == "a")
    }

    @Test func aGrowingRunKeepsItsRowId() {
        let before = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip")])
        let after = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip"), status("c", duck: "pip")])
        #expect(before.map(\.id) == after.map(\.id))
        let one = RoomFold.fold([status("a", duck: "pip")])
        #expect(one.map(\.id) == before.map(\.id))
    }

    @Test func aPersonsMessageEndsTheRun() {
        let out = RoomFold.fold([status("a", duck: "pip"), person("m"), status("b", duck: "pip")])
        #expect(out.count == 3)
        #expect(out.compactMap(line).allSatisfy { $0.earlier.isEmpty })
    }

    @Test func differentDucksDoNotFoldTogether() {
        let out = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "bo"), status("c", duck: "bo")])
        #expect(out.count == 2)
        #expect(line(out[1])?.earlier.map(\.id) == ["b"])
    }

    @Test func planAndTaskCardsNeverFold() {
        let plan = [status("a", duck: "pip", kind: .plan), status("b", duck: "pip", kind: .plan)]
        #expect(RoomFold.fold(plan).count == 2)
        let task = RoomItem.system(RoomSystemLine(id: "t", at: 1, text: "T", jobId: nil, buttons: [], task: nil))
        #expect(RoomFold.fold([status("a", duck: "pip"), task, status("b", duck: "pip")]).count == 3)
    }

    @Test func aDaySeparatorEndsTheRun() {
        let out = RoomFold.fold([status("a", duck: "pip"), .day(id: "d", label: "Today"), status("b", duck: "pip")])
        #expect(out.count == 3)
    }

    @Test func handoffsFoldWithTheSameDucksStatusLines() {
        let h = RoomItem.system(RoomSystemLine(
            id: "h", at: 1, text: "n", jobId: nil, buttons: [], handoff: RoomHandoff(fromSessionId: "pip", from: "pip", to: "bo", body: "note")))
        let out = RoomFold.fold([status("a", duck: "pip"), h])
        #expect(out.count == 1)
        #expect(line(out[0])?.handoff != nil)
    }

    @Test func earlierRowNamesTheDuckAndTurnsIntoHide() {
        #expect(RoomFold.earlierLabel(4, from: "Ruby 2") == "Show 4 earlier from Ruby 2")
        #expect(RoomFold.earlierLabel(4) == "Show 4 earlier")
        #expect(RoomFold.earlierLabel(4, from: "Ruby 2", open: true) == "Hide 4 earlier")
    }

    @Test func aFoldedRowKnowsItsDuckByName() {
        let out = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip")])
        #expect(line(out[0]).flatMap(RoomFold.owner(of:)) == "pip")
    }

    @Test func aRunOfOneIsNeverFolded() {
        let out = RoomFold.fold([person("m"), status("a", duck: "pip")])
        #expect(out.compactMap(line).allSatisfy { $0.earlier.isEmpty })
    }

    @Test func idsAreStableWhenALineArrives() {
        let before = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip")]).map(\.id)
        let after = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip"), status("c", duck: "pip")]).map(\.id)
        #expect(before == after)
        let appended = RoomFold.fold([status("a", duck: "pip"), status("b", duck: "pip"), person("m")]).map(\.id)
        #expect(Array(appended.prefix(1)) == before)
    }
}
