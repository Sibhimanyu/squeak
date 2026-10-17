import CryptoKit
import Foundation

public enum CacheError: Error, Equatable, Sendable {
    case decryptionFailed
    case corrupt
    case keyUnavailable
}

/// One AES-GCM encrypted container holding cached transcript messages and drafts.
/// The 256-bit key lives in the `KeyStore`; the file never holds plaintext.
public actor EncryptedCache {
    public struct Configuration: Sendable {
        public var directory: URL
        public var keyAccount: String
        public var messageLifetime: TimeInterval
        public var sizeCap: Int

        public init(
            directory: URL = EncryptedCache.defaultDirectory,
            keyAccount: String = "cache-key",
            messageLifetime: TimeInterval = 14 * 24 * 3600,
            sizeCap: Int = 50 * 1024 * 1024
        ) {
            self.directory = directory
            self.keyAccount = keyAccount
            self.messageLifetime = messageLifetime
            self.sizeCap = sizeCap
        }
    }

    struct Stored: Codable {
        var message: ChatMessage
        var storedAt: Date
    }

    struct Container: Codable {
        var version = 1
        var messages: [String: [Stored]] = [:]
        var drafts: [String: String] = [:]
    }

    public static var defaultDirectory: URL {
        URL.homeDirectory.appending(path: "Library/Application Support/Squeak Mac")
    }

    public static let fileName = "cache.squeak"

    private let config: Configuration
    private let keyStore: any KeyStore
    private let now: @Sendable () -> Date
    private var container: Container?

    public init(configuration: Configuration = Configuration(), keyStore: any KeyStore, now: @escaping @Sendable () -> Date = { Date() }) {
        self.config = configuration
        self.keyStore = keyStore
        self.now = now
    }

    public nonisolated var fileURL: URL { config.directory.appending(path: Self.fileName) }

    // MARK: Messages

    /// Merges messages into the cache. Existing ids keep their original store time.
    public func putMessages(_ messages: [ChatMessage], for key: SessionKey) throws {
        var c = try load()
        let name = key.stringValue
        var list = c.messages[name] ?? []
        var index: [String: Int] = [:]
        for (i, s) in list.enumerated() { index[s.message.id] = i }
        var changed = false
        for m in messages where m.state == nil {
            if let i = index[m.id] {
                if list[i].message != m { list[i].message = m; changed = true }
            } else {
                index[m.id] = list.count
                list.append(Stored(message: m, storedAt: now()))
                changed = true
            }
        }
        guard changed else { return }
        c.messages[name] = list
        container = c
        try persist()
    }

    public func messages(for key: SessionKey) throws -> [ChatMessage] {
        let c = try load()
        let cutoff = now().addingTimeInterval(-config.messageLifetime)
        return (c.messages[key.stringValue] ?? []).filter { $0.storedAt >= cutoff }.map(\.message)
    }

    public func allMessages() throws -> [SessionKey: [ChatMessage]] {
        let c = try load()
        let cutoff = now().addingTimeInterval(-config.messageLifetime)
        var out: [SessionKey: [ChatMessage]] = [:]
        for (name, list) in c.messages {
            guard let key = SessionKey(stringValue: name) else { continue }
            let live = list.filter { $0.storedAt >= cutoff }.map(\.message)
            if !live.isEmpty { out[key] = live }
        }
        return out
    }

    // MARK: Drafts

    public func setDraft(_ text: String?, for key: SessionKey) throws {
        var c = try load()
        let name = key.stringValue
        let trimmed = text.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        guard c.drafts[name] != trimmed else { return }
        c.drafts[name] = trimmed
        container = c
        try persist()
    }

    public func draft(for key: SessionKey) throws -> String? {
        try load().drafts[key.stringValue]
    }

    public func allDrafts() throws -> [SessionKey: String] {
        var out: [SessionKey: String] = [:]
        for (name, text) in try load().drafts {
            if let k = SessionKey(stringValue: name) { out[k] = text }
        }
        return out
    }

    // MARK: Lifecycle

    /// Removes expired messages and rewrites the file if anything went.
    public func pruneExpired() throws {
        var c = try load()
        let cutoff = now().addingTimeInterval(-config.messageLifetime)
        var changed = false
        for (name, list) in c.messages {
            let live = list.filter { $0.storedAt >= cutoff }
            if live.count != list.count { changed = true }
            c.messages[name] = live.isEmpty ? nil : live
        }
        guard changed else { return }
        container = c
        try persist()
    }

    /// Deletes the file and the key. Everything cached is gone for good.
    public func purge() throws {
        container = nil
        try? FileManager.default.removeItem(at: fileURL)
        try keyStore.removeKey(for: config.keyAccount)
    }

    // MARK: Internals

    private func symmetricKey(create: Bool) throws -> SymmetricKey? {
        if let data = try keyStore.key(for: config.keyAccount) {
            guard data.count == 32 else { throw CacheError.keyUnavailable }
            return SymmetricKey(data: data)
        }
        guard create else { return nil }
        let key = SymmetricKey(size: .bits256)
        try keyStore.setKey(key.withUnsafeBytes { Data($0) }, for: config.keyAccount)
        return key
    }

    private func load() throws -> Container {
        if let container { return container }
        guard let blob = try? Data(contentsOf: fileURL) else {
            let empty = Container()
            container = empty
            return empty
        }
        guard let key = try symmetricKey(create: false) else { throw CacheError.decryptionFailed }
        let plain: Data
        do {
            plain = try AES.GCM.open(try AES.GCM.SealedBox(combined: blob), using: key)
        } catch {
            throw CacheError.decryptionFailed
        }
        guard let decoded = try? Self.decoder.decode(Container.self, from: plain) else { throw CacheError.corrupt }
        container = decoded
        return decoded
    }

    private func persist() throws {
        guard var c = container, let key = try symmetricKey(create: true) else { throw CacheError.keyUnavailable }
        var blob = try seal(c, with: key)
        // Over the cap: drop the oldest messages first. Drafts are never dropped.
        while blob.count > config.sizeCap {
            var oldest: (name: String, index: Int, at: Date)?
            for (name, list) in c.messages {
                for (i, s) in list.enumerated() where oldest == nil || s.storedAt < oldest!.at {
                    oldest = (name, i, s.storedAt)
                }
            }
            guard let o = oldest else { break }
            c.messages[o.name]?.remove(at: o.index)
            if c.messages[o.name]?.isEmpty == true { c.messages[o.name] = nil }
            blob = try seal(c, with: key)
        }
        container = c
        try write(blob)
    }

    private func seal(_ c: Container, with key: SymmetricKey) throws -> Data {
        let plain = try Self.encoder.encode(c)
        guard let combined = try AES.GCM.seal(plain, using: key).combined else { throw CacheError.corrupt }
        return combined
    }

    private func write(_ blob: Data) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: config.directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let tmp = config.directory.appending(path: Self.fileName + ".tmp")
        try? fm.removeItem(at: tmp)
        guard fm.createFile(atPath: tmp.path, contents: blob, attributes: [.posixPermissions: 0o600]) else {
            throw CacheError.corrupt
        }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: config.directory.path)
        var url = fileURL
        if fm.fileExists(atPath: url.path) {
            _ = try fm.replaceItemAt(url, withItemAt: tmp)
        } else {
            try fm.moveItem(at: tmp, to: url)
        }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }()

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }()
}
