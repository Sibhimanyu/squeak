import Foundation

/// Which folder a chat's terminal opens in, and why there is none. A terminal belongs to a workspace, and a
/// workspace is its folder: two chats with the same folder share one terminal, another folder gets its own.
public enum TerminalWorkspace {
    public enum Availability: Equatable, Sendable {
        case available(folder: String)
        case unavailable(reason: String)

        public var folder: String? { if case .available(let f) = self { return f } else { return nil } }
    }

    public static let noFolder = "This chat has no folder on this Mac, so there is no terminal for it."
    public static let missingFolder = "This chat's folder is not on this Mac any more, so there is no terminal for it."

    /// `cwd` is the session's folder (nil for a chat without one). `isDirectory` is injected so tests need no disk.
    public static func availability(cwd: String?, isDirectory: (String) -> Bool = Self.isDirectoryOnDisk) -> Availability {
        guard let cwd, !cwd.trimmingCharacters(in: .whitespaces).isEmpty else { return .unavailable(reason: noFolder) }
        let folder = key(cwd)
        guard folder.hasPrefix("/") else { return .unavailable(reason: noFolder) }
        return isDirectory(folder) ? .available(folder: folder) : .unavailable(reason: missingFolder)
    }

    /// The registry key: the folder without `..`, `.` or a trailing slash.
    public static func key(_ cwd: String) -> String {
        let p = (cwd as NSString).standardizingPath
        return p.count > 1 && p.hasSuffix("/") ? String(p.dropLast()) : p
    }

    public static func isDirectoryOnDisk(_ path: String) -> Bool {
        var dir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &dir) && dir.boolValue
    }
}
