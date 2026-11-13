import Foundation
import SqueakCore
import XCTest
@testable import SqueakUI

final class PondListTests: XCTestCase {
    private func chat(_ key: String, _ state: String = "idle", repo: String = "shop", branch: String = "main", hour: Int = 10,
                      pond: String? = nil, workspace: String? = nil, question: Bool = false) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: key, conductorSessionId: nil, label: "\(repo) · \(branch)", agent: "claude", state: state,
            lastActivityAt: String(format: "2026-11-09T%02d:00:00Z", hour), detail: nil, git: nil, contextPercent: nil,
            turnId: nil, message: nil, choices: nil, title: key)
        if let pond { s.pond = .init(id: pond, name: pond.capitalized) }
        s.workspaceId = workspace
        return s
    }

    private func item(_ id: String, hour: Int?, hidden: Bool = false, labels: [String] = []) -> PondItem {
        var meta = PondMeta(); meta.hidden = hidden; meta.labels = labels
        meta.lastActivityAt = hour.map { String(format: "2026-11-09T%02d:00:00Z", $0) }
        return PondItem(id: id, name: id, pond: nil, sessions: [], meta: meta)
    }

    func testNewestOrderPutsLatestFirstAndStampLessLast() {
        // The Mac sorts; newest keeps its order untouched.
        let list = [item("b", hour: 9), item("none", hour: nil), item("a", hour: 12)]
        XCTAssertEqual(PondList.ordered(list, mode: .newest).map(\.id), ["b", "none", "a"])
    }

    func testManualOrderPutsUnplacedPondsOnTopInTheMacsOrderThenSavedOrder() {
        let list = [item("a", hour: 1), item("b", hour: 2), item("new1", hour: 5), item("c", hour: 3), item("new2", hour: 8)]
        XCTAssertEqual(PondList.ordered(list, mode: .manual(["c", "gone", "a", "b"])).map(\.id), ["new1", "new2", "c", "a", "b"])
    }

    func testHiddenPondsLeaveUnlessShownAndAreCounted() {
        let list = [item("a", hour: 1), item("h", hour: 2, hidden: true)]
        let shown = PondList.visible(list, showHidden: false)
        XCTAssertEqual(shown.items.map(\.id), ["a"])
        XCTAssertEqual(shown.hiddenCount, 1)
        let all = PondList.visible(list, showHidden: true)
        XCTAssertEqual(all.items.map(\.id), ["a", "h"])
        XCTAssertEqual(all.hiddenCount, 0)
    }

    func testLabelAndQueryNarrow() {
        let list = [item("alpha", hour: 1, labels: ["work"]), item("beta", hour: 2, labels: ["home"])]
        XCTAssertEqual(PondList.visible(list, showHidden: false, label: "home").items.map(\.id), ["beta"])
        XCTAssertEqual(PondList.visible(list, showHidden: false, query: "ALP").items.map(\.id), ["alpha"])
        XCTAssertEqual(PondList.labels(list), ["home", "work"])
    }

    func testBuildGroupsByPondAndKeepsPondlessChatsInOther() {
        let ponds = [PhoneSnapshot.Pond(id: "shop", name: "Shop", shared: false), .init(id: "empty", name: "Empty", shared: false)]
        let built = PondList.build(sessions: [chat("a", pond: "shop"), chat("b", repo: "term"), chat("c", pond: "ghost")], ponds: ponds)
        XCTAssertEqual(built.ponds.map(\.id), ["shop", "empty"])
        XCTAssertEqual(built.item("shop")?.sessions.map(\.key), ["a"])
        XCTAssertEqual(Set(built.other.map(\.key)), ["b", "c"])
    }

    func testRowsEqualTheSentPondsInTheirOrderAndAnUnknownRefGoesToOther() {
        let ponds = [PhoneSnapshot.Pond(id: "z", name: "Z", shared: false), .init(id: "a", name: "A", shared: false)]
        let built = PondList.build(sessions: [chat("x", pond: "ghost")], ponds: ponds)
        XCTAssertEqual(built.ponds.map(\.id), ["z", "a"])
        XCTAssertNil(built.item("ghost"))
        XCTAssertEqual(built.other.map(\.key), ["x"])
    }

    func testNoRowIsEverBuiltFromALabelWhenPondsWereSent() {
        let ponds = [PhoneSnapshot.Pond(id: "p1", name: "One", shared: false)]
        let built = PondList.build(sessions: [chat("a", repo: "shop"), chat("b", repo: "docs", pond: "other-ref")], ponds: ponds)
        XCTAssertEqual(built.ponds.map(\.id), ["p1"])
        XCTAssertFalse(built.ponds.contains { $0.id.hasPrefix("name:") })
    }

    func testNoPondsSentMeansNoRowsAndEveryChatIsOtherNeverARepoPond() {
        let worktreeChats = [chat("a", repo: "ushuaia"), chat("b", repo: "hong-kong"), chat("c", repo: "ushuaia")]
        let built = PondList.build(sessions: worktreeChats, ponds: [])
        XCTAssertTrue(built.ponds.isEmpty)
        XCTAssertEqual(Set(built.other.map(\.key)), ["a", "b", "c"])
    }

    func testHomeGroupsByPondIdNotByLabel() {
        let one = PhoneSnapshot.Pond(id: "p1", name: "App", shared: false)
        let groups = Presentation.projects(
            [chat("a", repo: "ushuaia", pond: "p1"), chat("b", repo: "hong-kong", pond: "p1"), chat("c", repo: "scratch")],
            ponds: [one])
        XCTAssertEqual(groups.map(\.id).sorted(), ["other", "p1"])
        XCTAssertEqual(groups.first { $0.id == "p1" }?.sessions.count, 2)
        XCTAssertEqual(groups.first { $0.id == "p1" }?.name, "P1")
        XCTAssertEqual(groups.first { $0.id == "other" }?.name, "Other")
    }

    func testJoinedKindDecodesAndShowsAsJoined() throws {
        let json = #"{"id":"j1","name":"Theirs","shared":true,"members":[],"kind":"joined"}"#
        let pond = try JSONDecoder().decode(PhoneSnapshot.Pond.self, from: Data(json.utf8))
        XCTAssertTrue(pond.isJoined)
        XCTAssertTrue(PondList.build(sessions: [], ponds: [pond]).item("j1")?.joined == true)
        let plain = try JSONDecoder().decode(PhoneSnapshot.Pond.self, from: Data(#"{"id":"p","name":"P","shared":false,"members":[]}"#.utf8))
        XCTAssertFalse(plain.isJoined)
    }

    func testStraysAreOneFoldedGroupNeverPondRowsEvenWhenTheirLabelsDiffer() {
        let ponds = [PhoneSnapshot.Pond(id: "shop", name: "Shop", shared: false)]
        // Worktree folders (hong-kong, luxembourg) in the label, no pond ref: they must not become ponds.
        let built = PondList.build(
            sessions: [chat("a", repo: "hong-kong", hour: 9), chat("b", repo: "luxembourg", hour: 11), chat("c", repo: "hong-kong", hour: 10)],
            ponds: ponds)
        XCTAssertEqual(built.ponds.map(\.id), ["shop"])
        XCTAssertEqual(built.other.map(\.key), ["b", "c", "a"])
        XCTAssertNil(built.item("name:hong-kong"))
        XCTAssertEqual(PondList.otherMatching(built.other, query: "").count, 3)
        XCTAssertEqual(PondList.otherMatching(built.other, query: "zzz").count, 0)
    }

    func testStreamsAreDerivedFromWorkspacesPinnedFirstThenNewest() {
        let sessions = [chat("a", branch: "fix", hour: 9, workspace: "w1"), chat("b", branch: "ui", hour: 11, workspace: "w2"),
                        chat("c", branch: "fix", hour: 10, workspace: "w1")]
        let one = PhoneSnapshot.Pond(id: "shop", name: "Shop", shared: false)
        let built = PondList.build(sessions: sessions.map { var s = $0; s.pond = .init(id: "shop", name: "Shop"); return s }, ponds: [one])
        let derived = PondList.streams(built.ponds[0])
        XCTAssertEqual(derived.live.map(\.id), ["w2", "w1"])
        XCTAssertEqual(derived.live[1].sessions.map(\.key), ["c", "a"])
        let pinned = PondList.sortStreams([
            StreamItem(id: "x", name: "x", branch: nil, pinned: false, sessions: [], lastActivity: Date()),
            StreamItem(id: "p", name: "p", branch: nil, pinned: true, sessions: [], lastActivity: .distantPast)])
        XCTAssertEqual(pinned.map(\.id), ["p", "x"])
    }

    func testScopesFilterAPondsThreads() {
        var wait = chat("w", "finished"); wait.asks = "Open a PR?"
        let it = PondItem(id: "p", name: "p", pond: .init(id: "p", name: "p", shared: false), sessions: [wait, chat("r", "working"), chat("d", "finished")], meta: PondMeta())
        XCTAssertEqual(PondList.sessions(it, scope: .all).count, 3)
        XCTAssertEqual(PondList.sessions(it, scope: .needsYou).map(\.key), ["w"])
        XCTAssertEqual(PondList.sessions(it, scope: .working).map(\.key), ["r"])
        XCTAssertTrue(PondList.sessions(it, scope: .shared).isEmpty)
    }

    func testLanesAreNeedsYouProgressDoneIdleNewestFirstAndSkipEmpty() {
        var wait = chat("w", "finished", hour: 1); wait.asks = "Ship it?"
        let lanes = PondList.lanes([chat("i", "idle", hour: 9), chat("d1", "finished", hour: 3), chat("d2", "error", hour: 4),
                                    chat("r", "working", hour: 2), wait])
        XCTAssertEqual(lanes.map(\.lane), [.needsYou, .working, .done, .idle])
        XCTAssertEqual(lanes[2].sessions.map(\.key), ["d2", "d1"])
        XCTAssertEqual(PondList.lanes([chat("r", "working")]).map(\.lane), [.working])
    }

    func testReorderingAVisibleListKeepsHiddenPondsInPlace() {
        let full = ["a", "h", "b", "c"]
        XCTAssertEqual(PondList.reordered(full: full, visible: ["a", "b", "c"], moving: IndexSet(integer: 2), to: 0), ["c", "h", "a", "b"])
    }

    func testPondColoursReadHexAndNamesOnly() {
        XCTAssertEqual(PondList.colourHex("#3B82F6"), 0x3B82F6)
        XCTAssertEqual(PondList.colourHex("ff0000"), 0xFF0000)
        XCTAssertEqual(PondList.colourHex("Teal"), 0x14B8A6)
        XCTAssertNil(PondList.colourHex("#12"))
        XCTAssertNil(PondList.colourHex("sparkly"))
        XCTAssertNil(PondList.colourHex(nil))
    }

    func testRecentSearchesDedupeAndCap() {
        var recent: [String] = []
        for q in ["a", "ab", "abc", "AB", "x1", "x2", "x3", "x4", "x5", "x6", "x7"] { recent = PondList.remembering(q, in: recent) }
        XCTAssertEqual(recent.count, 8)
        XCTAssertEqual(recent.first, "x7")
        XCTAssertEqual(PondList.remembering("AB", in: ["abc", "ab"]), ["AB", "abc"])
    }
}
