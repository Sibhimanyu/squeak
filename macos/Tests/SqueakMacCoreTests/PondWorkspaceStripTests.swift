import Foundation
import SqueakMacCore
import Testing

@Suite struct PondWorkspaceStripTests {
    private let pond = "project-1"
    private let file = TabItem.pondFile(root: "/stream", path: "Sources/A.swift")
    private let diff = TabItem.diff(session: "chat-a", path: "Sources/A.swift")
    private let review = TabItem.reviewAll(session: "chat-a")
    private let artifact = TabItem.artifact(pond: "project-1", path: "/artifacts/Poster.html")

    @Test func oneClickOpensOneItemAndReopeningOnlySelectsIt() {
        var store = TabStore()
        #expect(store.pondItems(pond).isEmpty)
        store.openPondItem(file, in: pond)
        store.openPondItem(diff, in: pond)
        store.openPondItem(file, in: pond)
        store.openPondItem(review, in: pond)
        #expect(store.pondItems(pond) == [file, review, diff])
        #expect(store.currentPondItem(pond) == review)
        #expect(store.pondItems("project-2").isEmpty)
        #expect(store.tabs(pond).isEmpty)
    }

    @Test func firstItemFromADuckGoesBeforeExistingItems() {
        var store = TabStore()
        store.openPondItem(file, in: pond)
        store.deselectPondItem(in: pond)
        store.openPondItem(diff, in: pond, afterDuck: true)
        #expect(store.pondItems(pond) == [diff, file])
    }

    @Test func aShownItemOpensInTheBackgroundEvenIfAlreadyOpen() {
        var store = TabStore()
        store.openPondItem(file, in: pond)
        store.openPondItem(diff, in: pond, focus: false)
        store.openPondItem(diff, in: pond, focus: false)
        #expect(store.pondItems(pond) == [file, diff])
        #expect(store.currentPondItem(pond) == file)
        store.openPondItem(artifact, in: "project-2", focus: false)
        #expect(store.pondItems("project-2") == [artifact])
        #expect(store.currentPondItem("project-2") == nil)
    }

    @Test func closingOnlyChangesItemsAndFallsBackToTheNearestItemOrPage() {
        var store = TabStore()
        let duck = TabItem.duck("a")
        store.open(duck, in: pond)
        store.openPondItem(duck, in: pond)
        store.openPondItem(file, in: pond)
        store.openPondItem(diff, in: pond)
        store.openPondItem(artifact, in: pond)
        #expect(!store.closePondItem(duck, in: pond))
        #expect(store.closePondItem(file, in: pond))
        #expect(store.currentPondItem(pond) == artifact)
        #expect(store.closePondItem(artifact, in: pond))
        #expect(store.currentPondItem(pond) == diff)
        #expect(store.closePondItem(diff, in: pond))
        #expect(store.currentPondItem(pond) == nil)
        #expect(store.tabs(pond) == [duck])
        #expect(store.current(pond) == duck)
    }

    @Test func closeCurrentDoesNothingWhenADuckOrPondPageIsShowing() {
        var store = TabStore()
        store.openPondItem(file, in: pond, focus: false)
        #expect(!store.closeCurrentPondItem(in: pond))
        #expect(store.pondItems(pond) == [file])
        store.openPondItem(file, in: pond)
        #expect(store.closeCurrentPondItem(in: pond))
        #expect(store.pondItems(pond).isEmpty)
    }

    @Test func pendingClassicMigrationPreservesItemsOpenedBeforePlacementWasKnown() throws {
        let suite = "PondWorkspaceMigration-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let old = #"{"strips":{"Same name/ducks":{"tabs":[{"kind":"thread","id":"chat"}]}}}"#
        defaults.set(Data(old.utf8), forKey: TabStore.legacyKey)
        var store = TabStore(restoring: defaults)
        store.openPondItem(file, in: pond, focus: false)
        store.save(pond: pond, to: defaults)

        store = TabStore(restoring: defaults)
        #expect(store.adoptLegacy(in: defaults) { $0 == "chat" ? pond : nil } == [pond])
        #expect(store.tabs(pond) == [.duck("chat:chat")])
        #expect(store.pondItems(pond) == [file])
    }

    @Test func persistenceSharesThePondKeyAndKeepsClassicTabsIndependent() throws {
        let suite = "PondWorkspaceStripTests-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var classic = TabStore()
        classic.openPreview(.file("legacy.md"), in: pond)
        classic.save(pond: pond, to: defaults)

        var store = TabStore(restoring: defaults)
        #expect(store.pondItems(pond).isEmpty)
        store.openPondItem(file, in: pond)
        store.openPondItem(.notebook, in: pond)
        store.openPondItem(artifact, in: "project-2", focus: false)
        store.openPondItem(diff, in: "")
        store.save(pond: pond, to: defaults)
        store.save(pond: "project-2", to: defaults)

        #expect(defaults.data(forKey: "tabs.pond.project-1") != nil)
        let restored = TabStore(restoring: defaults)
        #expect(restored.pondItems(pond) == [file, .notebook])
        #expect(restored.currentPondItem(pond) == .notebook)
        #expect(restored.pondItems("project-2") == [artifact])
        #expect(restored.pondItems("").isEmpty)
        #expect(restored.previewTab(pond) == .file("legacy.md"))
    }

    @Test func shortcutsFollowTheStripAndCycleAcrossBothKinds() {
        let roster = makeRoster()
        let strip = PondWorkspaceStrip(roster: roster, place: .room, items: [file, diff], current: diff)
        #expect(strip.target(at: 0) == strip.row.ducks.first.map { .duck($0.id) })
        #expect(strip.target(at: 2) == file)
        #expect(strip.target(at: 8) == nil)
        #expect(strip.step(by: 1) == strip.target(at: 0))
        #expect(strip.step(by: -1) == file)
        let room = PondWorkspaceStrip(roster: roster, place: .room, items: [file], current: nil)
        #expect(room.step(by: 1) == strip.target(at: 0))
        #expect(room.step(by: -1) == file)
        let empty = PondWorkspaceStrip(roster: RoomRoster.roster([]), place: .room, items: [], current: nil)
        #expect(empty.step(by: 1) == nil)
    }

    @Test func anOffDutyDuckAppearsOnlyWhileItsChatIsShowing() {
        let roster = makeRoster()
        let place = DuckRowPlace.chat(sessionId: "s-off", duckId: "off")
        let chat = PondWorkspaceStrip(roster: roster, place: place, items: [file], current: nil)
        #expect(chat.row.ducks.last?.id == "off")
        #expect(chat.row.ducks.last?.onDuty == false)
        #expect(chat.step(by: 1) == file)
        let item = PondWorkspaceStrip(roster: roster, place: place, items: [file], current: file)
        #expect(!item.row.ducks.contains { $0.id == "off" })
        #expect(roster.offDuty.map(\.id) == ["off"])
    }

    @Test func overflowFadesTheHiddenEdgesOnly() {
        #expect(!PondStripOverflow(contentStart: 0, contentEnd: 80, viewport: 100).isOverflowing)
        let start = PondStripOverflow(contentStart: 0, contentEnd: 180, viewport: 100)
        #expect(!start.leading && start.trailing)
        let end = PondStripOverflow(contentStart: -80, contentEnd: 100, viewport: 100)
        #expect(end.leading && !end.trailing)
        let middle = PondStripOverflow(contentStart: -40, contentEnd: 140, viewport: 100)
        #expect(middle.leading && middle.trailing)
    }

    private func makeRoster() -> DuckRoster {
        RoomRoster.roster([
            PondDuck(id: "a", name: "Ada", currentSessionId: "s-a"),
            PondDuck(id: "b", name: "Bo", currentSessionId: "s-b"),
            PondDuck(id: "off", name: "Cy", duty: .off, currentSessionId: "s-off"),
            PondDuck(id: "no-chat", name: "Dot")
        ])
    }

    @Test func itemIdentitiesIncludeTheSourceAndKeepFileAndDiffDistinct() {
        #expect(file != .pondFile(root: "/other-stream", path: "Sources/A.swift"))
        #expect(file.fileSource?.root == "/stream")
        #expect(file.fileSource?.path == "Sources/A.swift")
        #expect(diff != .diff(session: "chat-b", path: "Sources/A.swift"))
        #expect(diff.diffSource?.path == "Sources/A.swift")
        #expect(review.diffSource?.session == "chat-a")
        #expect(review.diffSource?.path == nil)
        #expect(file != diff)
    }
}
