import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Encrypted cache")
struct EncryptedCacheTests {
    let key = SessionKey(provider: "conductor", workspaceId: "ws", hostSessionId: "c1")

    func cache(
        dir: URL = tempDirectory(), keys: MemoryKeyStore = MemoryKeyStore(),
        lifetime: TimeInterval = 14 * 86400, cap: Int = 50 * 1024 * 1024, now: @escaping @Sendable () -> Date = { Date() }
    ) -> EncryptedCache {
        EncryptedCache(configuration: .init(directory: dir, messageLifetime: lifetime, sizeCap: cap), keyStore: keys, now: now)
    }

    @Test func roundTripsAcrossInstancesAndIsNotPlaintext() async throws {
        let dir = tempDirectory()
        let keys = MemoryKeyStore()
        let c1 = cache(dir: dir, keys: keys)
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        try await c1.putMessages([ChatMessage(id: "m1", role: .user, text: "very secret sentence", at: at, turnId: "T")], for: key)
        let raw = try Data(contentsOf: c1.fileURL)
        #expect(raw.range(of: Data("very secret sentence".utf8)) == nil)

        let c2 = cache(dir: dir, keys: keys)
        let back = try await c2.messages(for: key)
        #expect(back == [ChatMessage(id: "m1", role: .user, text: "very secret sentence", at: at, turnId: "T")])
    }

    @Test func wrongKeyFailsToDecrypt() async throws {
        let dir = tempDirectory()
        let c1 = cache(dir: dir)
        try await c1.putMessages([ChatMessage(id: "m1", role: .user, text: "hi")], for: key)
        let c2 = cache(dir: dir, keys: MemoryKeyStore()) // fresh store: no key
        await #expect(throws: CacheError.decryptionFailed) { try await c2.messages(for: key) }

        let other = MemoryKeyStore()
        try other.setKey(Data(repeating: 7, count: 32), for: "cache-key")
        let c3 = cache(dir: dir, keys: other)
        await #expect(throws: CacheError.decryptionFailed) { try await c3.messages(for: key) }
    }

    @Test func tamperedFileFailsToDecrypt() async throws {
        let dir = tempDirectory()
        let keys = MemoryKeyStore()
        let c1 = cache(dir: dir, keys: keys)
        try await c1.putMessages([ChatMessage(id: "m1", role: .user, text: "hi")], for: key)
        var raw = try Data(contentsOf: c1.fileURL)
        raw[raw.count - 20] ^= 0xFF
        try raw.write(to: c1.fileURL)
        await #expect(throws: CacheError.decryptionFailed) { try await cache(dir: dir, keys: keys).messages(for: key) }
    }

    @Test func messagesExpireAfterFourteenDays() async throws {
        let clock = Box(Date(timeIntervalSince1970: 1_800_000_000))
        let c = cache(now: { clock.current })
        try await c.putMessages([ChatMessage(id: "old", role: .user, text: "old")], for: key)
        clock.current = clock.current.addingTimeInterval(13 * 86400)
        try await c.putMessages([ChatMessage(id: "new", role: .user, text: "new")], for: key)
        #expect(try await c.messages(for: key).map(\.id) == ["old", "new"])
        clock.current = clock.current.addingTimeInterval(2 * 86400) // old is now 15 days
        #expect(try await c.messages(for: key).map(\.id) == ["new"])
        try await c.pruneExpired()
        #expect(try await c.allMessages()[key]?.map(\.id) == ["new"])
    }

    @Test func sizeCapDropsOldestFirst() async throws {
        let clock = Box(Date(timeIntervalSince1970: 1_800_000_000))
        let c = cache(cap: 6_000, now: { clock.current })
        let filler = String(repeating: "x", count: 300)
        for i in 0..<40 {
            clock.current = clock.current.addingTimeInterval(1)
            try await c.putMessages([ChatMessage(id: "m\(i)", role: .assistant, text: "\(i) \(filler)")], for: key)
        }
        let size = try FileManager.default.attributesOfItem(atPath: c.fileURL.path)[.size] as! Int
        #expect(size <= 6_000)
        let ids = try await c.messages(for: key).map(\.id)
        #expect(ids.last == "m39")
        #expect(!ids.contains("m0"))
        #expect(ids.count < 40 && ids.count > 5)
    }

    @Test func purgeDeletesFileAndKey() async throws {
        let keys = MemoryKeyStore()
        let c = cache(keys: keys)
        try await c.putMessages([ChatMessage(id: "m1", role: .user, text: "hi")], for: key)
        try await c.setDraft("draft", for: key)
        #expect(FileManager.default.fileExists(atPath: c.fileURL.path))
        #expect(try keys.key(for: "cache-key") != nil)
        try await c.purge()
        #expect(!FileManager.default.fileExists(atPath: c.fileURL.path))
        #expect(try keys.key(for: "cache-key") == nil)
        #expect(try await c.messages(for: key).isEmpty)
    }

    @Test func fileIsOwnerOnlyAndExcludedFromBackup() async throws {
        let c = cache()
        try await c.putMessages([ChatMessage(id: "m1", role: .user, text: "hi")], for: key)
        try await c.putMessages([ChatMessage(id: "m2", role: .user, text: "again")], for: key) // replace path
        let attrs = try FileManager.default.attributesOfItem(atPath: c.fileURL.path)
        #expect((attrs[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let values = try c.fileURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        #expect(values.isExcludedFromBackup == true)
        let dirAttrs = try FileManager.default.attributesOfItem(atPath: c.fileURL.deletingLastPathComponent().path)
        #expect(((dirAttrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0)
    }

    @Test func localSendStateIsNeverCached() async throws {
        let c = cache()
        try await c.putMessages([ChatMessage(id: "local-1", role: .user, text: "unsent", state: .pending)], for: key)
        #expect(try await c.messages(for: key).isEmpty)
    }
}

@Suite("Drafts")
struct DraftStoreTests {
    let a = SessionKey(provider: "conductor", workspaceId: "ws", hostSessionId: "a")
    let b = SessionKey(provider: "codex-terminal", hostSessionId: "b:c")

    @Test func draftsPersistPerSessionAndClear() async throws {
        let dir = tempDirectory()
        let keys = MemoryKeyStore()
        let make = { DraftStore(cache: EncryptedCache(configuration: .init(directory: dir), keyStore: keys)) }
        let store = make()
        try await store.save("one", for: a)
        try await store.save("two", for: b)
        let reopened = make()
        #expect(try await reopened.load(for: a) == "one")
        #expect(try await reopened.all() == [a: "one", b: "two"])
        try await reopened.clear(for: a)
        try await reopened.save("   ", for: b) // whitespace-only is no draft
        #expect(try await make().all().isEmpty)
    }
}

@Suite("Key stores")
struct KeyStoreTests {
    @Test func memoryStoreStoresAndRemoves() throws {
        let k = MemoryKeyStore()
        #expect(try k.key(for: "x") == nil)
        try k.setKey(Data([1, 2]), for: "x")
        #expect(try k.key(for: "x") == Data([1, 2]))
        try k.removeKey(for: "x")
        #expect(try k.key(for: "x") == nil)
    }
}
