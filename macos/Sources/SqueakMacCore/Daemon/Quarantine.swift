import Foundation

/// Removes macOS's download flag (`com.apple.quarantine`) from the service Squeak installs for itself.
/// A DMG downloaded in a browser flags the whole app, and a copy keeps the flag: launchd's start of the bundled,
/// unnotarized `node` is then held for ever by Gatekeeper. Only ever called with a folder inside Squeak's own support directory.
public enum Quarantine {
    public static let attribute = "com.apple.quarantine"

    public static func isQuarantined(_ url: URL) -> Bool {
        getxattr(url.path, attribute, nil, 0, 0, XATTR_NOFOLLOW) >= 0
    }

    /// Strips the flag from `root` and everything inside it (links are never followed). Returns how many items had it.
    @discardableResult
    public static func strip(under root: URL) -> Int {
        var count = 0
        func clear(_ path: String) {
            if removexattr(path, attribute, XATTR_NOFOLLOW) == 0 { count += 1 }
        }
        clear(root.path)
        let keys: [URLResourceKey] = [.isDirectoryKey]
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: keys, options: []) else { return count }
        for case let url as URL in walker { clear(url.path) }
        return count
    }
}
