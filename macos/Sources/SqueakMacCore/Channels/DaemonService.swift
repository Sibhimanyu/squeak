import Foundation

/// Restarts the daemon so it re-reads `.env`. The runner is injected so tests never run launchctl.
public struct DaemonService: Sendable {
    public typealias Runner = @Sendable (_ executable: String, _ arguments: [String]) async throws -> Int32

    public static let label = "com.squeak.daemon"
    private let runner: Runner
    private let uid: UInt32

    public init(uid: UInt32 = getuid(), runner: @escaping Runner = DaemonService.run) {
        self.uid = uid
        self.runner = runner
    }

    public static func kickstartArguments(uid: UInt32) -> [String] {
        ["kickstart", "-k", "gui/\(uid)/\(label)"]
    }

    public enum RestartError: Error, Equatable { case failed(Int32) }

    public func restart() async throws {
        let code = try await runner("/bin/launchctl", Self.kickstartArguments(uid: uid))
        if code != 0 { throw RestartError.failed(code) }
    }

    public static let run: Runner = { executable, arguments in
        try await withCheckedThrowingContinuation { cont in
            let p = Process()
            p.executableURL = URL(fileURLWithPath: executable)
            p.arguments = arguments
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            p.terminationHandler = { cont.resume(returning: $0.terminationStatus) }
            do { try p.run() } catch { cont.resume(throwing: error) }
        }
    }
}
