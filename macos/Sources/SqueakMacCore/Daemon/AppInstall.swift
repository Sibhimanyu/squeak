import Foundation

/// The claim file `<supportDir>/app-install.json`: tells the daemon which app owns it, so it can clean
/// up if that app is dragged to the Trash. Only an app that writes it makes its daemon "app-managed".
public enum AppInstall {
    public static let fileName = "app-install.json"

    public static func defaultSupportDir() -> URL {
        FileManager.default.homeDirectoryForCurrentUser.appending(path: "Library/Application Support/squeak")
    }

    /// Dev builds (`.build`, `macos/build`) must never arm the watchdog.
    public static func isBuildFolder(_ path: String) -> Bool {
        path.contains("/.build/") || path.contains("/macos/build/")
    }

    public static func json(appPath: String, bundleId: String, version: String, writtenAt: Date) throws -> Data {
        let object: [String: Any] = [
            "v": 1, "appPath": appPath, "bundleId": bundleId, "version": version,
            "writtenAt": Int((writtenAt.timeIntervalSince1970 * 1000).rounded()),
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    /// Atomic, 0600. Throws on failure; callers ignore it.
    public static func write(
        appPath: String, bundleId: String, version: String, supportDir: URL, now: Date = Date()
    ) throws {
        let data = try json(appPath: appPath, bundleId: bundleId, version: version, writtenAt: now)
        let fm = FileManager.default
        try fm.createDirectory(at: supportDir, withIntermediateDirectories: true)
        let tmp = supportDir.appending(path: ".\(fileName).\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            _ = try fm.replaceItemAt(supportDir.appending(path: fileName), withItemAt: tmp)
        } catch {
            try? fm.removeItem(at: tmp)
            throw error
        }
    }

    /// The running app's claim; silent no-op from a build folder, silent on failure.
    public static func writeForRunningApp(bundle: Bundle = .main, supportDir: URL = defaultSupportDir()) {
        let path = bundle.bundleURL.path
        guard bundle.bundleURL.pathExtension == "app", !isBuildFolder(path),
            let id = bundle.bundleIdentifier,
            let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        else { return }
        try? write(appPath: path, bundleId: id, version: version, supportDir: supportDir)
    }
}
