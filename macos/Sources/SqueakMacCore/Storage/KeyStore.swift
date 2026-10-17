import Foundation
import Security

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

public struct KeychainError: Error, Equatable, Sendable {
    public var status: OSStatus
}

/// Generic-password items in the user's login Keychain, service `com.squeak.mac`.
public struct KeychainKeyStore: KeyStore {
    public let service: String

    public init(service: String = "com.squeak.mac") {
        self.service = service
    }

    private func base(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func key(for account: String) throws -> Data? {
        var q = base(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    public func setKey(_ key: Data, for account: String) throws {
        let update = SecItemUpdate(base(account) as CFDictionary, [kSecValueData as String: key] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError(status: update) }
        var add = base(account)
        add[kSecValueData as String] = key
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func removeKey(for account: String) throws {
        let status = SecItemDelete(base(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
