import Foundation
import XCTest
@testable import SqueakCore

final class MacRegistryTests: XCTestCase {
    final class Memory: SecretStore {
        var items: [String: Data] = [:]
        func load(account: String) -> Data? { items[account] }
        func save(_ data: Data, account: String) { items[account] = data }
        func delete(account: String) { items[account] = nil }
    }

    private func pairing(_ channel: String, name: String) -> PairingPayload {
        PairingPayload(v: 1, p: "", c: channel, k: Data(repeating: 7, count: 32).base64EncodedString(), n: name,
                       cu: "https://relay.example.com", ck: nil)
    }

    private let studio = String(repeating: "S", count: 22)
    private let laptop = String(repeating: "L", count: 22)
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    // MARK: migration

    func testSinglePairingMigratesToTheFirstOpenMac() throws {
        let memory = Memory()
        memory.items["pairing"] = try JSONEncoder().encode(pairing(studio, name: "Studio"))
        memory.items["device-id"] = Data("dev-1".utf8)
        memory.items["approved"] = Data("1".utf8)

        let registry = MacRegistryStore(secrets: memory).load()

        XCTAssertEqual(registry.entries.count, 1)
        XCTAssertEqual(registry.activeId, studio)
        let entry = try XCTUnwrap(registry.active)
        XCTAssertEqual(entry.name, "Studio")
        XCTAssertEqual(entry.deviceId, "dev-1")
        XCTAssertTrue(entry.approved)
        // The migrated Mac keeps the original cache file names: nothing on disk is moved.
        XCTAssertNil(entry.cacheKey)
        // The old items are gone, the new one is there.
        for account in MacRegistryStore.legacyAccounts { XCTAssertNil(memory.items[account], account) }
        XCTAssertNotNil(memory.items[MacRegistryStore.account])
    }

    func testMigrationRunsOnceAndASecondLoadReadsTheList() throws {
        let memory = Memory()
        memory.items["pairing"] = try JSONEncoder().encode(pairing(studio, name: "Studio"))
        memory.items["device-id"] = Data("dev-1".utf8)
        let store = MacRegistryStore(secrets: memory)
        let first = store.load()
        // Even if an old item reappears (a restore), the list wins and is not overwritten.
        memory.items["pairing"] = try JSONEncoder().encode(pairing(laptop, name: "Laptop"))
        memory.items["device-id"] = Data("dev-2".utf8)
        XCTAssertEqual(store.load(), first)
        XCTAssertEqual(store.load().entries.map(\.macId), [studio])
    }

    func testAnUnapprovedQRPairingMigratesAsWaiting() throws {
        let memory = Memory()
        memory.items["pairing"] = try JSONEncoder().encode(pairing(studio, name: "Studio"))
        memory.items["device-id"] = Data("dev-1".utf8)
        XCTAssertEqual(MacRegistryStore(secrets: memory).load().active?.approved, false)
    }

    func testNothingStoredIsEmptyAndHalfAnItemIsNotAMac() throws {
        let memory = Memory()
        XCTAssertTrue(MacRegistryStore(secrets: memory).load().isEmpty)
        memory.items["pairing"] = try JSONEncoder().encode(pairing(studio, name: "Studio"))   // no device id
        XCTAssertTrue(MacRegistryStore(secrets: memory).load().isEmpty)
        memory.items["macs"] = Data("not json".utf8)
        let before = memory.items["macs"]
        XCTAssertTrue(MacRegistryStore(secrets: memory).load().isEmpty)
        XCTAssertEqual(memory.items["macs"], before, "an unreadable list is never overwritten")
    }

    func testRoundTripAndWipe() throws {
        let memory = Memory()
        let store = MacRegistryStore(secrets: memory)
        var registry = MacRegistry()
        registry.upsert(MacEntry(pairing: pairing(studio, name: "Studio"), deviceId: "a", approved: true))
        registry.upsert(MacEntry(pairing: pairing(laptop, name: "Laptop"), deviceId: "b", approved: true), makeActive: false)
        store.save(registry)
        XCTAssertEqual(store.load(), registry)
        store.wipe()
        XCTAssertTrue(store.load().isEmpty)
    }

    // MARK: several Macs

    func testSwitchingKeepsEachMacsOwnState() {
        var registry = MacRegistry()
        var studioEntry = MacEntry(pairing: pairing(studio, name: "Studio"), deviceId: "a", approved: true)
        studioEntry.lastSeen = t0
        registry.upsert(studioEntry)
        registry.upsert(MacEntry(pairing: pairing(laptop, name: "Laptop"), deviceId: "b", approved: true))
        XCTAssertEqual(registry.activeId, laptop)

        XCTAssertTrue(registry.activate(studio))
        XCTAssertEqual(registry.active?.deviceId, "a")
        XCTAssertEqual(registry.active?.lastSeen, t0)
        XCTAssertTrue(registry.activate(laptop))
        XCTAssertEqual(registry.active?.deviceId, "b")
        XCTAssertNil(registry.active?.lastSeen)
        XCTAssertFalse(registry.activate("unknown"))
        XCTAssertEqual(registry.activeId, laptop)

        // Each Mac has its own cache files.
        let keys = registry.entries.map(\.cacheKey)
        XCTAssertEqual(Set(keys).count, 2)
        XCTAssertFalse(keys.contains { $0 == nil })
    }

    func testReAddingAMacKeepsItsCacheAndHistory() {
        var registry = MacRegistry()
        var first = MacEntry(pairing: pairing(studio, name: "Studio"), deviceId: "a", approved: true)
        first.cacheKey = nil
        first.lastSeen = t0
        registry.upsert(first)
        let again = MacEntry(pairing: pairing(studio, name: "Studio 2"), deviceId: "z", approved: true)
        registry.upsert(again)
        XCTAssertEqual(registry.entries.count, 1)
        XCTAssertEqual(registry.active?.deviceId, "z")
        XCTAssertEqual(registry.active?.name, "Studio 2")
        XCTAssertEqual(registry.active?.cacheKey, first.cacheKey)
        XCTAssertEqual(registry.active?.lastSeen, t0)
    }

    func testRemovingTheOpenMacOpensTheNextAndTheLastLeavesNone() {
        var registry = MacRegistry()
        registry.upsert(MacEntry(pairing: pairing(studio, name: "Studio"), deviceId: "a", approved: true))
        registry.upsert(MacEntry(pairing: pairing(laptop, name: "Laptop"), deviceId: "b", approved: true))
        registry.remove(laptop)
        XCTAssertEqual(registry.activeId, studio)
        registry.remove(studio)
        XCTAssertNil(registry.activeId)
        XCTAssertTrue(registry.isEmpty)
    }

    func testCachesAreSeparatePerMac() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("macs-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let a = SnapshotStore(directory: dir, name: "aaa", delay: 0)
        let b = SnapshotStore(directory: dir, name: "bbb", delay: 0)
        let legacy = SnapshotStore(directory: dir, delay: 0)
        let snapshot = try JSONDecoder().decode(PhoneSnapshot.self, from: Data(
            #"{"v":1,"mac":"A","generatedAt":"2026-11-14T10:00:00Z","duck":{"blockedCount":0,"workingCount":0},"sessions":[]}"#.utf8))
        a.record(snapshot)
        a.flush()
        XCTAssertEqual(a.load(now: Date())?.mac, "A")
        // A fresh store on the same name sees it (it is on disk), and the other names stay empty.
        XCTAssertEqual(SnapshotStore(directory: dir, name: "aaa").load(now: Date())?.mac, "A")
        XCTAssertNil(b.load(now: Date()))
        XCTAssertNil(legacy.load(now: Date()))
        a.clear()
        let deadline = Date().addingTimeInterval(2)
        while a.load(now: Date()) != nil, Date() < deadline { usleep(20_000) }
        XCTAssertNil(a.load(now: Date()))
    }

    // MARK: the list

    func testPresenceIsOnlineAsleepOrOffline() {
        let now = t0
        XCTAssertEqual(MacPresence.classify(lastSeen: now.addingTimeInterval(-30), now: now), .online)
        XCTAssertEqual(MacPresence.classify(lastSeen: now.addingTimeInterval(-20 * 60), now: now), .asleep(since: now.addingTimeInterval(-20 * 60)))
        XCTAssertEqual(MacPresence.classify(lastSeen: now.addingTimeInterval(-3 * 86400), now: now), .offline(since: now.addingTimeInterval(-3 * 86400)))
        XCTAssertEqual(MacPresence.classify(lastSeen: nil, now: now), .unknown)
        // What the relay says wins over the age.
        XCTAssertEqual(MacPresence.classify(lastSeen: now.addingTimeInterval(-5), reported: "asleep", now: now), .asleep(since: now.addingTimeInterval(-5)))
        XCTAssertEqual(MacPresence.classify(lastSeen: nil, reported: "online", now: now), .online)
    }

    func testAnAsleepMacSaysSoInsteadOfLookingBroken() {
        let now = t0
        let asleep = MacPresence.classify(lastSeen: now.addingTimeInterval(-12 * 60), now: now)
        XCTAssertEqual(asleep.label(now: now), "Asleep \u{00B7} last seen 12 min ago")
        XCTAssertTrue(asleep.hint?.contains("asleep") == true)
        XCTAssertEqual(MacPresence.online.label(now: now), "Online")
        XCTAssertNil(MacPresence.online.hint)
        XCTAssertEqual(MacPresence.offline(since: now.addingTimeInterval(-2 * 86400)).label(now: now), "Offline \u{00B7} last seen 2 d ago")
    }

    func testRowsMergeTheAccountWithWhatThePhoneHolds() {
        var registry = MacRegistry()
        var held = MacEntry(pairing: pairing(studio, name: "Studio"), deviceId: "a", approved: true)
        held.lastSeen = t0.addingTimeInterval(-10)
        registry.upsert(held)
        // A QR-paired Mac the account does not list.
        registry.upsert(MacEntry(pairing: pairing("Q" + String(repeating: "q", count: 21), name: "Old Mac"), deviceId: "q", approved: true), makeActive: false)
        let account = [
            AccountMac(macId: studio, name: "Studio"),
            AccountMac(macId: laptop, name: "Laptop", lastSeenAt: t0.addingTimeInterval(-600), requiresApproval: true),
        ]
        let rows = MacList.rows(account: account, registry: registry, now: t0)
        XCTAssertEqual(rows.map(\.name), ["Studio", "Laptop", "Old Mac"])
        XCTAssertEqual(rows[0].presence, .online)
        XCTAssertTrue(rows[0].held && rows[0].isActive)
        XCTAssertEqual(rows[1].presence, .asleep(since: t0.addingTimeInterval(-600)))
        XCTAssertFalse(rows[1].held)
        XCTAssertTrue(rows[1].requiresApproval)
        XCTAssertEqual(rows[2].presence, .unknown)
        XCTAssertTrue(rows[2].held)
    }

    func testAnOlderRelayListDecodesWithNoNewFields() async throws {
        struct Http: AccountHTTP {
            func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
                (200, Data(#"{"macs":[{"macId":"M","name":"Mac","linkedAt":1}]}"#.utf8))
            }
        }
        let api = AccountAPI(appURL: "https://app.example.com", token: "t", http: Http())
        let macs = try await api.macs()
        XCTAssertEqual(macs, [AccountMac(macId: "M", name: "Mac")])
    }

    // MARK: the signed-out screen

    func testSignedOutOffersSignInAndOnlyOneSmallLinkToTheCode() {
        XCTAssertEqual(SignInScreen.entries, [.signIn, .macNotOnAccount])
        let words = [SignInScreen.title, SignInScreen.detail, SignInScreen.signInLabel, SignInScreen.providers].joined(separator: " ").lowercased()
        for banned in ["scan", "qr", "code", "pair", "approve", "link one"] { XCTAssertFalse(words.contains(banned), banned) }
        XCTAssertEqual(SignInScreen.fallbackLabel, "Mac not on an account yet?")
    }

    func testOpeningAMacNeverShowsACode() {
        XCTAssertEqual(SignInScreen.opening("Studio", needsApproval: false), "Opening Studio\u{2026}")
        XCTAssertEqual(SignInScreen.opening("Studio", needsApproval: true), "Waiting for Studio to approve")
        XCTAssertEqual(SignInScreen.opening("", needsApproval: true), "Waiting for your Mac to approve")
    }
}
