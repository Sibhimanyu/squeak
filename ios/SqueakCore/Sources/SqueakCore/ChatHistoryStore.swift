import CryptoKit
import Foundation
#if canImport(Security)
import Security
#endif

/// The chat-history cache on the device (docs/remote-channel.md, "History cache"): per Mac id, per chat, the
/// messages the phone has read, so a chat opens from disk and only what came after its newest message is asked of
/// the Mac (`HistoryCommand.after`).
///
/// Session text is sensitive, so each chat is one file, AES-256-GCM under a random 32-byte key that lives in the
/// Keychain (`HistoryKeychain`, this-device-only, after first unlock) and nowhere else; the file is written with
/// Data Protection `.completeUntilFirstUserAuthentication`, kept out of backups, and named by a hash of the chat
/// key, so the disk holds neither a word of a chat nor which chats exist. The folder is per Mac id: removing a
/// Mac or signing out wipes that folder and its key.
///
/// Eviction is least recently opened first (a file's modification date is its last-opened time, touched on
/// `load`), down to `maxChats` chats and `maxBytes` per Mac. Nothing here blocks the caller: `record` only queues
/// (writes are coalesced to one a second), `load` is async, and the work runs on a private serial queue.
public final class ChatHistoryStore: @unchecked Sendable {
    public static let maxChats = 200
    public static let maxBytes = 50 * 1024 * 1024
    /// Entries kept per chat on disk (the newest); the cursor moves to match so the rest can be asked for again.
    public static let maxEntries = 1000

    private struct File: Codable { var v = 1; var key: String; var state: ChatHistoryState }

    private let folder: URL
    private let key: SymmetricKey
    private let maxChats: Int
    private let maxBytes: Int
    private let delay: TimeInterval
    private let queue = DispatchQueue(label: "squeak.chat-history", qos: .utility)
    private let lock = NSLock()
    private var pending: [String: ChatHistoryState] = [:]
    private var scheduled: DispatchWorkItem?

    /// `directory` is the parent of every Mac's folder; `macId` names this Mac's (hashed, so it never leaks).
    public init(directory: URL, macId: String, key: SymmetricKey, maxChats: Int = ChatHistoryStore.maxChats,
                maxBytes: Int = ChatHistoryStore.maxBytes, delay: TimeInterval = 1) {
        self.folder = Self.folder(directory, macId: macId)
        self.key = key
        self.maxChats = maxChats
        self.maxBytes = maxBytes
        self.delay = delay
    }

    /// The app's own store for a Mac: Application Support, Keychain key. Nil when the Keychain cannot make a key.
    public static func standard(macId: String) -> ChatHistoryStore? {
        #if canImport(Security)
        guard let key = HistoryKeychain.key(macId: macId) else { return nil }
        return ChatHistoryStore(directory: defaultDirectory, macId: macId, key: key)
        #else
        return nil
        #endif
    }

    public static var defaultDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("ChatHistory")
    }

    static func folder(_ directory: URL, macId: String) -> URL { directory.appendingPathComponent(digest(macId), isDirectory: true) }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    private func url(_ chatKey: String) -> URL { folder.appendingPathComponent(Self.digest(chatKey) + ".sqh") }

    /// What is held for a chat (also marks it opened, so it is the last to be evicted); nil when nothing is.
    public func load(_ chatKey: String) async -> ChatHistoryState? {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.read(chatKey, touch: true)) }
        }
    }

    /// The newest `limit` chats by last opened, for filling the in-memory cache at launch.
    public func recent(limit: Int) async -> [String: ChatHistoryState] {
        await withCheckedContinuation { continuation in
            queue.async {
                let files = self.listing().sorted { $0.opened > $1.opened }.prefix(limit)
                var out: [String: ChatHistoryState] = [:]
                for file in files {
                    if let stored = self.open(file.url) { out[stored.key] = stored.state }
                }
                continuation.resume(returning: out)
            }
        }
    }

    /// Remember a chat's history. Empty history is ignored. Returns at once; the write follows within `delay`.
    public func record(_ state: ChatHistoryState, for chatKey: String) {
        guard !state.entries.isEmpty else { return }
        var state = state
        state.trimTo(Self.maxEntries)
        lock.lock()
        pending[chatKey] = state
        let needsSchedule = scheduled == nil
        if needsSchedule {
            let item = DispatchWorkItem { [weak self] in self?.flushNow() }
            scheduled = item
            queue.asyncAfter(deadline: .now() + delay, execute: item)
        }
        lock.unlock()
    }

    /// Write what is queued now and wait for it (tests; going to the background).
    public func flush() {
        lock.lock(); scheduled?.cancel(); scheduled = nil; lock.unlock()
        queue.sync { self.flushNow() }
    }

    /// Delete this Mac's folder: its chats and nothing else. The caller removes the Keychain key (`HistoryKeychain`).
    public func wipe() {
        lock.lock(); pending = [:]; scheduled?.cancel(); scheduled = nil; lock.unlock()
        queue.sync { try? FileManager.default.removeItem(at: self.folder) }
    }

    /// Delete every Mac's store, and every key (signing out).
    public static func wipeAll(directory: URL = defaultDirectory) {
        try? FileManager.default.removeItem(at: directory)
        #if canImport(Security)
        HistoryKeychain.removeAll()
        #endif
    }

    // MARK: queue-only

    private func flushNow() {
        lock.lock()
        let batch = pending
        pending = [:]
        scheduled = nil
        lock.unlock()
        guard !batch.isEmpty else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for (chatKey, state) in batch { write(chatKey, state) }
        evict()
    }

    private func write(_ chatKey: String, _ state: ChatHistoryState) {
        guard let plain = try? JSONEncoder().encode(File(key: chatKey, state: state)),
              let sealed = try? AES.GCM.seal(plain, using: key).combined else { return }
        var target = url(chatKey)
        #if os(iOS)
        let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        #else
        let options: Data.WritingOptions = [.atomic]
        #endif
        guard (try? sealed.write(to: target, options: options)) != nil else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }

    private func read(_ chatKey: String, touch: Bool) -> ChatHistoryState? {
        let target = url(chatKey)
        guard let stored = open(target), stored.key == chatKey else { return nil }
        if touch { try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path) }
        return stored.state
    }

    private func open(_ target: URL) -> File? {
        guard let data = try? Data(contentsOf: target), let box = try? AES.GCM.SealedBox(combined: data),
              let plain = try? AES.GCM.open(box, using: key),
              let file = try? JSONDecoder().decode(File.self, from: plain), file.v == 1 else { return nil }
        return file
    }

    private struct Listed { let url: URL; let opened: Date; let size: Int }

    private func listing() -> [Listed] {
        let keys: [URLResourceKey] = [.contentModificationDateKey, .fileSizeKey]
        let urls = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys)) ?? []
        return urls.filter { $0.pathExtension == "sqh" }.compactMap { u in
            let v = try? u.resourceValues(forKeys: Set(keys))
            return Listed(url: u, opened: v?.contentModificationDate ?? .distantPast, size: v?.fileSize ?? 0)
        }
    }

    /// Least recently opened first, until the chat and byte limits hold.
    func evict() {
        var files = listing().sorted { $0.opened > $1.opened }
        var bytes = files.reduce(0) { $0 + $1.size }
        while let last = files.last, files.count > maxChats || bytes > maxBytes {
            try? FileManager.default.removeItem(at: last.url)
            bytes -= last.size
            files.removeLast()
        }
    }
}

#if canImport(Security)
/// The history store's keys: one random 256-bit key per Mac id in the Keychain, readable after the first unlock,
/// never synced or backed up. Losing a key only means the cache is unreadable and refetched.
public enum HistoryKeychain {
    private static let service = "com.squeak.phone.history"

    public static func key(macId: String) -> SymmetricKey? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecAttrAccount as String: macId, kSecReturnData as String: true]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data, data.count == 32 {
            return SymmetricKey(data: data)
        }
        let fresh = SymmetricKey(size: .bits256)
        let data = fresh.withUnsafeBytes { Data($0) }
        var add = query
        add[kSecReturnData as String] = nil
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemDelete(query as CFDictionary)
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess ? fresh : nil
    }

    public static func remove(macId: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                       kSecAttrAccount as String: macId] as CFDictionary)
    }

    public static func removeAll() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }
}
#endif
