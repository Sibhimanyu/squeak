import Foundation

public protocol KeyStore: Sendable {
    func key(for account: String) throws -> Data?
    func setKey(_ key: Data, for account: String) throws
    func removeKey(for account: String) throws
}

/// For tests and previews. Never touches the Keychain.
public final class MemoryKeyStore: KeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: Data] = [:]

    public init() {}

    public func key(for account: String) throws -> Data? {
        lock.withLock { keys[account] }
    }

    public func setKey(_ key: Data, for account: String) throws {
        lock.withLock { keys[account] = key }
    }

    public func removeKey(for account: String) throws {
        _ = lock.withLock { keys.removeValue(forKey: account) }
    }
}

/// Keys as files beside the cache: `<directory>/<account>.key`, mode 0600 in a 0700 folder,
/// excluded from backups. Not the Keychain on purpose: Squeak is ad-hoc signed, so every build
/// and every update has a new code identity, and macOS would ask the user to allow the Keychain
/// item again each time. The cache it protects is a local, rebuildable copy.
public struct FileKeyStore: KeyStore {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    private func url(_ account: String) -> URL {
        let safe = account.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "." ? $0 : "_" }
        return directory.appending(path: String(safe) + ".key")
    }

    public func key(for account: String) throws -> Data? {
        let file = url(account)
        guard FileManager.default.fileExists(atPath: file.path) else { return nil }
        return try Data(contentsOf: file)
    }

    public func setKey(_ key: Data, for account: String) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var file = url(account)
        try key.write(to: file, options: [.atomic])
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? file.setResourceValues(values)
    }

    public func removeKey(for account: String) throws {
        let file = url(account)
        guard FileManager.default.fileExists(atPath: file.path) else { return }
        try FileManager.default.removeItem(at: file)
    }
}
