import Foundation
import Testing
@testable import SqueakMacCore

@Suite struct TabStoreTests {
    private let a = TabItem.duck("duck-a"), b = TabItem.duck("duck-b"), c = TabItem.duck("duck-c")
    private func defaults() -> UserDefaults {
        let name = "TabStoreTests-\(UUID().uuidString)"
        let d = UserDefaults(suiteName: name)!
        d.removePersistentDomain(forName: name)
        return d
    }

    // MARK: No seeding

    @Test func aPondWithNoSavedListHasAnEmptyStripAndNothingCurrent() {
        let store = TabStore()
        #expect(store.tabs("pond").isEmpty)
        #expect(store.current("pond") == nil)
    }

    @Test func openingOneThingOpensExactlyThatOneTab() {
        var store = TabStore()
        store.open(a, in: "pond")
        #expect(store.tabs("pond") == [a])
        #expect(store.current("pond") == a)
        #expect(store.tabs("other").isEmpty)
    }

    // MARK: Identity

    /// Two Ponds can share a repo or folder name; each is its own project id and keeps its own list.
    @Test func twoPondsWithTheSameNameKeepSeparateLists() {
        let d = defaults()
        var store = TabStore()
        store.open(a, in: "project-1")
        store.open(b, in: "project-2")
        store.open(.file("/f"), in: "project-2")
        #expect(store.tabs("project-1") == [a])
        #expect(store.tabs("project-2") == [b, .file("/f")])
        store.save(pond: "project-1", to: d); store.save(pond: "project-2", to: d)
        let back = TabStore(restoring: d)
        #expect(back.tabs("project-1") == [a])
        #expect(back.tabs("project-2") == [b, .file("/f")])
    }

    @Test func aPondNotKnownYetOpensAndSavesNothing() {
        var store = TabStore()
        store.open(a, in: "")
        store.openPreview(.file("x"), in: "")
        #expect(store.tabs("").isEmpty)
        let d = defaults()
        store.save(pond: "", to: d)
        #expect(d.data(forKey: TabStore.defaultsKey("")) == nil)
    }

    // MARK: Open / switch / insert after current

    @Test func openingWhatIsAlreadyOpenSwitchesToItNeverADuplicate() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p")
        store.open(a, in: "p")
        #expect(store.tabs("p") == [a, b])
        #expect(store.current("p") == a)
    }

    @Test func aNewTabOpensRightAfterTheCurrentOne() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p")      // [a, b], current b
        store.select(a, in: "p")
        store.open(c, in: "p")
        #expect(store.tabs("p") == [a, c, b])
        #expect(store.current("p") == c)
    }

    @Test func selectingOnlyWorksOnAnOpenTab() {
        var store = TabStore()
        store.open(a, in: "p")
        let r1 = store.select(b, in: "p")
        #expect(!r1)
        #expect(store.tabs("p") == [a])
    }

    // MARK: Close

    @Test func closingChangesOnlyTheListAndMovesCurrentToTheRightNeighbour() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p"); store.open(c, in: "p")
        store.select(b, in: "p")
        let r2 = store.close(b, in: "p")
        #expect(r2 == c)
        #expect(store.tabs("p") == [a, c])
        let r3 = store.close(c, in: "p")
        #expect(r3 == a)
        let r4 = store.close(a, in: "p")
        #expect(r4 == nil)
        #expect(store.tabs("p").isEmpty)
        #expect(store.current("p") == nil)
    }

    @Test func closingANonCurrentTabKeepsTheCurrentOne() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p")
        store.close(a, in: "p")
        #expect(store.current("p") == b)
    }

    @Test func aClosedTabIsNotBroughtBackByTheStore() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p")
        store.close(a, in: "p")
        store.adoptDucks { _ in nil }
        store.prune { _ in true }
        #expect(store.tabs("p") == [b])
    }

    // MARK: Move

    @Test func moveUsesTheTabDropLanding() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(b, in: "p"); store.open(c, in: "p")
        let r5 = store.move(a, to: .init(anchor: c, side: .after), in: "p")
        #expect(r5)
        #expect(store.tabs("p") == [b, c, a])
        let again = store.move(a, to: .init(anchor: c, side: .after), in: "p")   // already there
        #expect(!again)
        let r6 = store.move(a, to: .init(anchor: .duck("gone"), side: .before), in: "p")
        #expect(!r6)
    }

    // MARK: Preview

    @Test func aSingleClickedFileTakesThePreviewSlotAndPinningKeepsIt() {
        var store = TabStore()
        store.open(a, in: "p")
        let r7 = store.openPreview(.file("x"), in: "p")
        #expect(r7 == nil)
        let r8 = store.openPreview(.file("y"), in: "p")
        #expect(r8 == .file("x"))
        #expect(store.tabs("p") == [a, .file("y")])
        let r9 = store.pin(.file("y"), in: "p")
        #expect(r9)
        let r10 = store.openPreview(.file("z"), in: "p")
        #expect(r10 == nil)
        #expect(store.tabs("p") == [a, .file("y"), .file("z")])
    }

    @Test func aDuckIsNeverAPreview() {
        var store = TabStore()
        store.openPreview(a, in: "p")
        #expect(store.tabs("p") == [a])
        #expect(!store.isPreview(a, in: "p"))
    }

    // MARK: A Duck is one tab and follows the Duck

    private func chat(_ id: String, duck: String?) -> HostSession {
        var s = HostSession(key: SessionKey(provider: "claude-squeak", workspaceId: nil, hostSessionId: id))
        s.duckId = duck
        return s
    }

    @Test func aDucksTabIsItsDuckIdSoANewChatOfTheDuckIsTheSameTab() {
        let first = chat("s1", duck: "D"), second = chat("s2", duck: "D")
        #expect(TabItem.of(first) == TabItem.of(second))
        var store = TabStore()
        store.open(.of(first), in: "p")
        store.open(.of(second), in: "p")
        #expect(store.tabs("p") == [.duck("D")])
    }

    @Test func aChatNoDuckOwnsIsItsOwnTabByKey() {
        let s = chat("s9", duck: nil)
        #expect(TabItem.of(s).chatKey == s.key.stringValue)
        #expect(TabItem.duck("D").chatKey == nil)
    }

    @Test func chatIdentitiesBecomeDuckIdsWhenTheChatsAreLearnedAndDuplicatesMerge() {
        var store = TabStore()
        store.open(.duck("D"), in: "p")
        store.open(.duck("chat:k1"), in: "p")
        store.open(.duck("chat:k2"), in: "p")
        let changed = store.adoptDucks { $0 == "k1" ? "D" : $0 == "k2" ? "E" : nil }
        #expect(changed == ["p"])
        #expect(store.tabs("p") == [.duck("D"), .duck("E")])
        #expect(store.current("p") == .duck("E"))
        let none = store.adoptDucks { _ in nil }
        #expect(none.isEmpty)
    }

    // MARK: A tab whose thing is gone closes itself

    @Test func aDeletedDuckAndARemovedFileCloseTheirTabs() {
        var store = TabStore()
        store.open(a, in: "p"); store.open(.file("/x"), in: "p"); store.open(b, in: "q")
        let changed = store.prune { $0 != a && $0 != .file("/x") }
        #expect(changed == ["p"])
        #expect(store.tabs("p").isEmpty)
        #expect(store.tabs("q") == [b])
    }

    // MARK: Persistence

    @Test func eachPondSavesUnderItsOwnKeyAndRestoresExactlyAsLeft() {
        let d = defaults()
        var store = TabStore()
        store.open(a, in: "one"); store.open(.file("/f"), in: "one"); store.select(a, in: "one")
        store.open(b, in: "two")
        store.save(pond: "one", to: d)
        store.save(pond: "two", to: d)
        #expect(d.data(forKey: TabStore.defaultsKey("one")) != nil)
        #expect(d.data(forKey: TabStore.defaultsKey("two")) != nil)
        let back = TabStore(restoring: d)
        #expect(back == store)
        #expect(back.tabs("one") == [a, .file("/f")])
        #expect(back.current("one") == a)
        #expect(back.tabs("two") == [b])
    }

    @Test func savingOnePondLeavesTheOthersKeyAlone() {
        let d = defaults()
        var store = TabStore()
        store.open(a, in: "one"); store.save(pond: "one", to: d)
        let before = d.data(forKey: TabStore.defaultsKey("one"))
        store.open(b, in: "two"); store.save(pond: "two", to: d)
        #expect(d.data(forKey: TabStore.defaultsKey("one")) == before)
    }

    /// The regression: opening a pond twice (a relaunch in between) gives the same tabs; nothing is added by the second visit.
    @Test func openingAPondTwiceYieldsTheSameTabs() {
        let d = defaults()
        var first = TabStore(restoring: d)
        #expect(first.tabs("pond").isEmpty)
        first.open(a, in: "pond"); first.open(.file("/f"), in: "pond")
        first.save(pond: "pond", to: d)
        let second = TabStore(restoring: d)
        let third = TabStore(restoring: d)
        #expect(second.tabs("pond") == first.tabs("pond"))
        #expect(third.tabs("pond") == second.tabs("pond"))
        #expect(third.current("pond") == second.current("pond"))
    }

    // MARK: Migration

    private let legacy = """
    {"strips":{
      "greenroom/ducks":{"tabs":[{"kind":"thread","id":"claude-squeak:squeak-native:s1"},{"kind":"file","id":"/a.txt"},{"kind":"thread","id":"claude-squeak:squeak-native:s2"}],
                        "selected":{"kind":"thread","id":"claude-squeak:squeak-native:s2"}},
      "greenroom//Users/x/greenroom":{"tabs":[{"kind":"thread","id":"old"}]},
      "empty/ducks":{"tabs":[]}
    }}
    """

    /// The chats' placement (their Pond's id), as the app knows it from the host: never the name the old strip was saved under.
    private func pondOf(_ key: String) -> String? { key.hasSuffix(":s1") || key.hasSuffix(":s2") ? "project-1" : nil }

    @Test func theSavedDucksStripWaitsForItsPondIdThenBecomesThatPondsList() {
        let d = defaults()
        d.set(Data(legacy.utf8), forKey: TabStore.legacyKey)
        var store = TabStore(restoring: d)
        // Not placed yet: nothing is guessed by name.
        #expect(store.tabs("greenroom").isEmpty)
        let early = store.adoptLegacy(in: d) { _ in nil }
        #expect(early.isEmpty)
        let adopted = store.adoptLegacy(in: d, pondOf: pondOf)
        #expect(adopted == ["project-1"])
        #expect(store.tabs("project-1") == [.duck("chat:claude-squeak:squeak-native:s1"), .file("/a.txt"), .duck("chat:claude-squeak:squeak-native:s2")])
        #expect(store.current("project-1") == .duck("chat:claude-squeak:squeak-native:s2"))
        #expect(store.tabs("greenroom").isEmpty)
        #expect(d.data(forKey: TabStore.legacyKey) == nil)
        #expect(d.data(forKey: TabStore.legacyPondKey("greenroom")) == nil)
        // Once adopted, a second run neither migrates again nor finds it waiting.
        d.set(Data(legacy.utf8), forKey: TabStore.legacyKey)
        var again = TabStore(restoring: d)
        let nothing = again.adoptLegacy(in: d, pondOf: pondOf)
        #expect(nothing.isEmpty)
        #expect(again.tabs("project-1") == store.tabs("project-1"))
    }

    @Test func aWaitingStripSurvivesARelaunchBeforeItsPondIsKnown() {
        let d = defaults()
        d.set(Data(legacy.utf8), forKey: TabStore.legacyKey)
        _ = TabStore(restoring: d)
        var relaunched = TabStore(restoring: d)
        let adopted = relaunched.adoptLegacy(in: d, pondOf: pondOf)
        #expect(adopted == ["project-1"])
    }

    @Test func migratedChatKeysMapToDuckIds() {
        let d = defaults()
        d.set(Data(legacy.utf8), forKey: TabStore.legacyKey)
        var store = TabStore(restoring: d)
        store.adoptLegacy(in: d, pondOf: pondOf)
        store.adoptDucks { key in key.hasSuffix(":s1") ? "duck-1" : key.hasSuffix(":s2") ? "duck-2" : nil }
        #expect(store.tabs("project-1") == [.duck("duck-1"), .file("/a.txt"), .duck("duck-2")])
        #expect(store.current("project-1") == .duck("duck-2"))
    }

    @Test func unreadableLegacyDataMigratesToNothing() {
        #expect(TabStore.migrate(legacy: Data("nope".utf8)).isEmpty)
    }
}
