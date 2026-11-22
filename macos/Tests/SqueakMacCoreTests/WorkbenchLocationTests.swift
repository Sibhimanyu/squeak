import XCTest
@testable import SqueakMacCore

final class WorkbenchLocationTests: XCTestCase {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "squeak", hostSessionId: id) }

    func testRecallPerPondAndWorkspace() {
        var m = PlaceMemory()
        m.remember(.chat(key("a")), pond: "p1", workspace: "w1")
        m.remember(.chat(key("b")), pond: "p1", workspace: "w2")
        m.remember(.chat(key("c")), pond: "p2", workspace: "w3")
        XCTAssertEqual(m.lastChat(pond: "p1"), key("b"))
        XCTAssertEqual(m.lastChat(pond: "p2"), key("c"))
        XCTAssertEqual(m.lastChat(workspace: "w1"), key("a"))
        XCTAssertEqual(m.lastChat(workspace: "w2"), key("b"))
        XCTAssertNil(m.lastChat(pond: "p3"))
        m.remember(.pondHome(pond: "p1"), pond: "p1", workspace: nil)
        m.remember(.home, pond: "p1", workspace: "w1")
        XCTAssertEqual(m.lastChat(pond: "p1"), key("b"), "only chats are remembered")
    }

    func testPondsAreMatchedByKeyNotName() {
        var m = PlaceMemory()
        m.remember(.chat(key("a")), pond: "id-1", workspace: nil)
        XCTAssertNil(m.lastChat(pond: "Squeak"))
        XCTAssertNil(m.lastChat(pond: ""))
    }

    func testPruneDropsDeletedSessions() {
        var m = PlaceMemory()
        m.remember(.chat(key("a")), pond: "p1", workspace: "w1")
        m.remember(.chat(key("b")), pond: "p2", workspace: "w2")
        m.prune(existing: [key("b")])
        XCTAssertNil(m.lastChat(pond: "p1"))
        XCTAssertNil(m.lastChat(workspace: "w1"))
        XCTAssertEqual(m.lastChat(pond: "p2"), key("b"))
        XCTAssertEqual(m.lastChat(workspace: "w2"), key("b"))
    }

    func testCodableRoundTripThroughDefaults() throws {
        var m = PlaceMemory()
        m.remember(.chat(SessionKey(provider: "claude", installation: "local", workspaceId: "w", hostSessionId: "s")), pond: "p", workspace: "w")
        let suite = UserDefaults(suiteName: "WorkbenchLocationTests-\(UUID().uuidString)")!
        m.save(suite)
        XCTAssertEqual(PlaceMemory.load(suite), m)
        XCTAssertEqual(PlaceMemory.load(UserDefaults(suiteName: "WorkbenchLocationTests-empty-\(UUID().uuidString)")!), PlaceMemory())
    }

    func testLocationRoundTrip() throws {
        let all: [WorkbenchLocation] = [
            .home, .pondHome(pond: "p"), .pondThread(pond: "p", pondId: "x", threadId: "t"), .pondSettings(pond: "p"), .archived,
            .chat(key("a")), .compose(.newThread, pond: "p", workspace: "w"), .compose(.newPond, pond: nil, workspace: nil), .settings(.about), .usage,
        ]
        for l in all { XCTAssertEqual(try JSONDecoder().decode(WorkbenchLocation.self, from: JSONEncoder().encode(l)), l) }
    }

    func testDerivedAccessors() {
        XCTAssertTrue(WorkbenchLocation.archived.isPondRoute)
        XCTAssertFalse(WorkbenchLocation.chat(key("a")).isPondRoute)
        XCTAssertEqual(WorkbenchLocation.pondThread(pond: "p", pondId: "x", threadId: "t").pondKey, "p")
        XCTAssertEqual(WorkbenchLocation.resting(chat: key("a")), .chat(key("a")))
        XCTAssertEqual(WorkbenchLocation.resting(chat: nil), .home)
        XCTAssertFalse(WorkbenchLocation.compose(.quickMessage, pond: nil, workspace: nil).isRecorded)
    }

    func testHistoryRecordsPondHome() {
        var h = NavHistory<WorkbenchLocation>()
        h.visit(.chat(key("a")))
        h.visit(.pondHome(pond: "p"))
        h.visit(.pondHome(pond: "p"))
        h.visit(.chat(key("b")))
        XCTAssertEqual(h.back(), .some(.pondHome(pond: "p")))
        XCTAssertEqual(h.back(), .some(.chat(key("a"))))
        XCTAssertNil(h.back())
        XCTAssertEqual(h.forward(), .some(.pondHome(pond: "p")))
        h.visit(.home)
        XCTAssertFalse(h.canGoForward, "visiting from the middle drops what was ahead")
        XCTAssertEqual(h.lastVisited { $0.chatKey != nil }, .chat(key("a")))
    }

    func testSettingsAndUsageAreRecordedAndRoundTrip() {
        var h = NavHistory<WorkbenchLocation>()
        h.visit(.chat(key("a")))
        h.visit(.settings(.about))
        h.visit(.settings(.privacy))
        h.visit(.usage)
        XCTAssertTrue(WorkbenchLocation.settings(.about).isRecorded)
        XCTAssertTrue(WorkbenchLocation.usage.isRecorded)
        XCTAssertEqual(h.back(), .some(.settings(.privacy)))
        XCTAssertEqual(h.back(), .some(.settings(.about)))
        XCTAssertEqual(h.back(), .some(.chat(key("a"))))
        XCTAssertEqual(h.forward(), .some(.settings(.about)))
        XCTAssertEqual(h.forward(), .some(.settings(.privacy)))
        XCTAssertEqual(h.forward(), .some(.usage))
        XCTAssertEqual(WorkbenchLocation.settings(.cliq).settingsSection, .cliq)
        XCTAssertNil(WorkbenchLocation.usage.settingsSection)
    }

    func testRestoreMarkerCarriesTheLocation() throws {
        for place in [WorkbenchLocation.chat(key("a")), .settings(.iphone), .usage, .pondHome(pond: "p"), .archived] {
            let m = UpdateRestoreMarker(fromVersion: "2.0.0", window: .conversation, location: place, savedAt: Date(timeIntervalSince1970: 1000))
            let back = try XCTUnwrap(UpdateRestoreMarker.decode(m.encoded()))
            XCTAssertEqual(back, m)
            XCTAssertEqual(back.restoredLocation, place)
        }
    }

    func testOlderMarkerWithoutLocationStillRestores() throws {
        let old = #"{"fromVersion":"2.0.0","window":"settings","session":"squeak:abc","settingsSection":"privacy","savedAt":1000}"#
        let m = try JSONDecoder().decode(UpdateRestoreMarker.self, from: Data(old.utf8))
        XCTAssertNil(m.location)
        XCTAssertEqual(m.restoredLocation, .settings(.privacy))
        let chat = UpdateRestoreMarker(fromVersion: "2.0.0", window: .conversation, session: key("a").stringValue)
        XCTAssertEqual(chat.restoredLocation, .chat(key("a")))
    }

    // MARK: A location never points at a pond that is gone

    func testLeaveClearsEveryPlaceThatPointedAtThePond() {
        let live: Set<String>? = ["keep"]
        XCTAssertEqual(WorkbenchLocation.pondHome(pond: "gone").prune(livePonds: live), .home)
        XCTAssertEqual(WorkbenchLocation.pondSettings(pond: "gone").prune(livePonds: live), .home)
        XCTAssertEqual(WorkbenchLocation.pondThread(pond: "gone", pondId: "x", threadId: "t").prune(livePonds: live), .home)
        XCTAssertEqual(WorkbenchLocation.compose(.newThread, pond: "gone", workspace: nil).prune(livePonds: live), .home)
        XCTAssertEqual(WorkbenchLocation.pondHome(pond: "keep").prune(livePonds: live), .pondHome(pond: "keep"))
        XCTAssertEqual(WorkbenchLocation.archived.prune(livePonds: live), .archived)
        XCTAssertEqual(WorkbenchLocation.chat(key("a")).prune(livePonds: live), .chat(key("a")))

        var memory = PlaceMemory()
        memory.remember(.chat(key("a")), pond: "gone", workspace: nil)
        memory.remember(.chat(key("b")), pond: "keep", workspace: nil)
        memory.prune(livePonds: live)
        XCTAssertNil(memory.lastChat(pond: "gone"))
        XCTAssertEqual(memory.lastChat(pond: "keep"), key("b"))
    }

    func testBackAfterLeaveNeverReachesThePond() {
        var h = NavHistory<WorkbenchLocation>()
        h.visit(nil)
        h.visit(.pondHome(pond: "gone"))
        h.visit(.pondSettings(pond: "gone"))
        h.visit(.pondHome(pond: "keep"))
        h.visit(nil)
        h.prune(keeping: { $0 == nil || $0!.prune(livePonds: ["keep"]) == $0! })
        var seen: [WorkbenchLocation?] = []
        while case .some(let place) = h.back() { seen.append(place) }
        XCTAssertEqual(seen.count, 2)
        XCTAssertFalse(seen.contains { $0?.pondKey == "gone" })
        XCTAssertEqual(seen.first ?? nil, .pondHome(pond: "keep"))
        XCTAssertFalse(h.canGoBack)
    }

    func testHistoryPruneKeepsTheCurrentStop() {
        var h = NavHistory<WorkbenchLocation>()
        h.visit(.pondHome(pond: "keep"))
        h.visit(.pondHome(pond: "gone"))
        h.visit(.archived)
        _ = h.back()
        _ = h.back()
        h.prune(keeping: { $0?.prune(livePonds: ["keep"]) == $0 })
        XCTAssertFalse(h.canGoBack)
        XCTAssertTrue(h.canGoForward)
    }

    func testUnloadedDirectoryPrunesNothing() {
        XCTAssertEqual(WorkbenchLocation.pondHome(pond: "any").prune(livePonds: nil), .pondHome(pond: "any"))
        var memory = PlaceMemory()
        memory.remember(.chat(key("a")), pond: "any", workspace: nil)
        memory.prune(livePonds: nil)
        XCTAssertEqual(memory.lastChat(pond: "any"), key("a"))
    }

    func testDirectoryLiveKeys() {
        let d = PondDirectory(ponds: [PondDirectory.Pond(id: "p", name: "P", projectId: "proj", hidden: false, labels: [], folder: nil)])
        XCTAssertTrue(d.hasPond(key: "p"))
        XCTAssertFalse(d.hasPond(key: "gone"))
    }

    func testArtifactLocationIsRecordedPrunedAndBelongsToItsPond() {
        let a = WorkbenchLocation.artifact(pond: "p", path: "/r/deck.pptx")
        XCTAssertEqual(a.artifactPath, "/r/deck.pptx")
        XCTAssertTrue(a.isArtifact && a.isRecorded && !a.isPondRoute && !a.isSettings)
        XCTAssertEqual(a.pondKey, "p")
        XCTAssertEqual(a.prune(livePonds: ["p"]), a)
        XCTAssertEqual(a.prune(livePonds: ["q"]), .home)
        XCTAssertNil(WorkbenchLocation.home.artifactPath)
        var h = NavHistory<WorkbenchLocation>()
        h.visit(.pondHome(pond: "p"))
        h.visit(a)
        XCTAssertEqual(h.back(), .some(.pondHome(pond: "p")))
        XCTAssertEqual(h.forward(), .some(a))
        XCTAssertEqual(WorkbenchFocus.resolve(a, place: { _ in nil }).pond, "p")
    }
}
