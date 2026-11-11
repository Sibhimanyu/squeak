import Foundation

/// Restarts the daemon so it re-reads `.env`. The runner is injected so tests never run launchctl.
public struct DaemonService: Sendable {
    public typealias Runner = @Sendable (_ executable: String, _ arguments: [String]) async throws -> Int32

    public static let label = "com.squeak.daemon"
    public static let hostLabel = "com.squeak.host"
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

    public enum RunError: Error, Equatable { case timedOut }

    /// How long one launchctl call may take before it is killed (a held exec or a wedged launchd never answers).
    public static let launchctlDeadline: Double = 30

    public static let run: Runner = { executable, arguments in
        let r = await ProcessCapture.run(executable, arguments, timeout: launchctlDeadline, grace: 2)
        if r.timedOut { throw RunError.timedOut }
        if let code = r.exit { return code }
        if r.signal != nil { return -1 }
        throw CocoaError(.fileNoSuchFile)
    }
}
