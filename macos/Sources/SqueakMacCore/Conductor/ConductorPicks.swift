import Foundation

/// Conductor is opt-in per workspace: a Conductor chat reaches the Mac app only when its workspace is picked
/// (the daemon's `conductorWorkspaces`). The one place that decides is `ConductorLocalAdapter.discover`, which
/// filters with `ConductorPicks.keeps`, so the sidebar, Home, the menu-bar panel, search, the palette and
/// notifications all see the same set.
public enum ConductorPicks {
    /// Whether a chat in `workspaceId` shows. Nothing known (nil) or nothing picked shows nothing.
    public static func keeps(workspaceId: String, picked: Set<String>?) -> Bool {
        guard let picked else { return false }
        return picked.contains(workspaceId)
    }

    /// The picked set to use now. A reachable daemon is the truth: its list, or, when it predates the field,
    /// nothing. An unreachable one falls back to the last list it sent (`cached`), and to nothing if never known.
    public static func resolve(state: DaemonState?, cached: Set<String>?) -> (picked: Set<String>, toCache: Set<String>?) {
        guard let state else { return (cached ?? [], nil) }
        guard let list = state.conductorWorkspaces else { return ([], nil) }
        return (Set(list), Set(list))
    }
}

/// The last picked set, kept in UserDefaults so the filter holds with the daemon down.
public struct ConductorPicksCache: @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "conductorPickedWorkspaces"

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public var value: Set<String>? {
        get { defaults.stringArray(forKey: key).map(Set.init) }
        nonmutating set {
            if let newValue { defaults.set(newValue.sorted(), forKey: key) } else { defaults.removeObject(forKey: key) }
        }
    }

    /// Reads the daemon's `/state` and returns the set to filter by, remembering a fresh one.
    public func current(client: DaemonClient) async -> Set<String> {
        let state = try? await client.state()
        let r = ConductorPicks.resolve(state: state, cached: value)
        if let c = r.toCache { value = c }
        return r.picked
    }
}
