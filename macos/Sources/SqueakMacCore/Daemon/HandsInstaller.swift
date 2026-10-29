import Foundation

/// Brings the Squeak Hands bundled in the app (`Contents/Helpers/Squeak Hands.app`) to where the daemon looks
/// for it (`~/Library/Application Support/squeak/Squeak Hands.app`), when that copy is missing or older.
/// Hands is signed with the same identity either way, so the Accessibility grant (tied to the path and the
/// signature) survives a replacement. Never a downgrade, so an owner's newer checkout build is left alone.
public enum HandsInstaller {
    public enum Outcome: Equatable, Sendable {
        case noBundledCopy
        case upToDate
        case installed(version: Int)
        case failed(String)
    }

    /// `CFBundleVersion` of an app bundle, 0 when there is none.
    public static func version(of app: URL) -> Int {
        let plist = app.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist),
              let object = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return 0 }
        if let s = object["CFBundleVersion"] as? String { return Int(s) ?? 0 }
        return object["CFBundleVersion"] as? Int ?? 0
    }

    public static func reconcile(bundled: URL, installed: URL, fileManager fm: FileManager = .default) -> Outcome {
        guard fm.fileExists(atPath: bundled.path) else { return .noBundledCopy }
        let have = fm.fileExists(atPath: installed.path) ? version(of: installed) : -1
        let offered = version(of: bundled)
        guard offered > have else { return .upToDate }
        do {
            try fm.createDirectory(at: installed.deletingLastPathComponent(), withIntermediateDirectories: true)
            let staging = installed.deletingLastPathComponent().appendingPathComponent(".Squeak Hands.new")
            try? fm.removeItem(at: staging)
            try fm.copyItem(at: bundled, to: staging)
            if fm.fileExists(atPath: installed.path) {
                _ = try fm.replaceItemAt(installed, withItemAt: staging)
            } else {
                try fm.moveItem(at: staging, to: installed)
            }
            return .installed(version: offered)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}
