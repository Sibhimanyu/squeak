import Foundation

/// The engine (session host) keeps its old version while a chat runs; this is the catch-up: keep watching, restart the
/// moment nothing is running, or restart anyway when the person says so. Pure decisions plus the persisted flag.
public enum EngineCatchUp {
    public enum Action: Equatable, Sendable {
        case none
        /// `chats` is nil when the host could not be read (assumed busy).
        case wait(chats: Int?)
        case restart
    }

    public static let pendingKey = "squeak.engine.restartPending"
    public static let pollSeconds: Double = 15

    public static func decide(pending: Bool, probe: HostProbe, force: Bool = false) -> Action {
        guard pending else { return .none }
        if force || !DaemonInstaller.hostIsBusy(probe) { return .restart }
        return .wait(chats: busyChats(probe))
    }

    /// Chats a restart would stop; nil for an unreadable answer.
    public static func busyChats(_ probe: HostProbe) -> Int? {
        switch probe {
        case .down: 0
        case .unreadable: nil
        case .sessions(let statuses): statuses.filter { DaemonInstaller.hostIsBusy(.sessions(statuses: [$0])) }.count
        }
    }

    public static func line(chats: Int?) -> String {
        guard let chats else { return "Engine update waits for running chats" }
        return "Engine update waits for \(chats) \(chats == 1 ? "chat" : "chats")"
    }

    public static func confirmText(chats: Int?) -> String {
        guard let chats else { return "Restarting stops any running chats." }
        return "Restarting stops \(chats) running \(chats == 1 ? "chat" : "chats")."
    }
}

/// The pending flag, kept across relaunches so a relaunch keeps waiting.
public struct EngineCatchUpStore: @unchecked Sendable {
    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
    public var pending: Bool {
        get { defaults.bool(forKey: EngineCatchUp.pendingKey) }
        nonmutating set { defaults.set(newValue, forKey: EngineCatchUp.pendingKey) }
    }
}

public enum HostCatchUpResult: Equatable, Sendable {
    /// Nothing pending applies (not our host, or not loaded): drop the flag.
    case cleared
    case waiting(chats: Int?)
    case restarted
    /// The restart did not bring the host back in time; stay pending.
    case failed
}

extension DaemonInstallerRunner {
    /// One look at a deferred host restart. Restarts through the same install path as `reconcileHost`, then waits
    /// up to 10 s for the host to answer.
    public func catchUpHost(force: Bool = false, waitSeconds: Int = 10) async -> HostCatchUpResult {
        guard effects.hostPlistArguments() != nil, await effects.hostLoaded() else { return .cleared }
        switch EngineCatchUp.decide(pending: true, probe: await effects.hostProbe(), force: force) {
        case .none: return .cleared
        case .wait(let chats): return .waiting(chats: chats)
        case .restart:
            do {
                try effects.writeHostPlist()
                if await !effects.kickstartHost() { _ = await effects.bootstrapHost() }
            } catch { return .failed }
            for _ in 0..<(waitSeconds * 2) {
                if await effects.hostProbe() != .down { return .restarted }
                try? await Task.sleep(for: .milliseconds(500))
            }
            return .failed
        }
    }
}
