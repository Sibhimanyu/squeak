import Foundation
import SqueakMacCore

/// The pond's ducks as the host lists them, for the room inspector's Ducks section. `ducks` is nil on a host without the
/// duck route (the inspector then shows the room page's threads). Actions are shown at once and reconciled by duck id with
/// the host's answer; a refusal puts the row back and shows its sentence inline.
@MainActor @Observable
final class RoomRosterModel {
    let projectId: String
    private(set) var ducks: [PondDuck]?
    /// The daemon's dashboard numbers; nil from an older daemon (the page then counts its rows).
    private(set) var counts: PondCounts?
    /// Chats whose duck is off duty: the dashboard's Off duty filter.
    var offDutySessions: Set<String> { Set((ducks ?? []).filter { $0.duty == .off }.compactMap(\.currentSessionId)) }
    var error: String?
    private(set) var creating = false

    init(projectId: String) { self.projectId = projectId }

    func refresh(host: NativeHostClient) async {
        guard let r = try? await DuckClient(host: host).roster(project: projectId) else { return }
        ducks = r.ducks; counts = r.counts
    }

    /// Rename, set role, duty: optimistic.
    func perform(_ action: DuckAction, host: NativeHostClient) async {
        let before = ducks
        error = nil
        if var list = ducks {
            switch action {
            case .rename(let id, let n): if let i = list.firstIndex(where: { $0.id == id }) { list[i].name = n }
            case .setRole(let id, let r): if let i = list.firstIndex(where: { $0.id == id }) { list[i].role = r }
            case .duty(let id, let on): if let i = list.firstIndex(where: { $0.id == id }) { list[i].duty = on ? .on : .off }
            case .create: break
            }
            ducks = list
        }
        do {
            let duck = try await DuckClient(host: host).perform(action)
            ducks = RoomRoster.upserting(duck, into: ducks ?? [])
            await refresh(host: host)   // the daemon's counts follow the change
        } catch {
            ducks = before
            self.error = RoomTasks.refusal(error)
        }
    }

    /// Creates the duck; the new one appears idle, with no place. Returns its name when it was made.
    func create(name: String, role: String?, host: NativeHostClient) async -> PondDuck? {
        creating = true; error = nil
        defer { creating = false }
        do {
            let duck = try await DuckClient(host: host).perform(.create(project: projectId, name: name, role: role))
            ducks = RoomRoster.upserting(duck, into: ducks ?? [])
            return duck
        } catch {
            self.error = RoomTasks.refusal(error)
            return nil
        }
    }
}

@MainActor
final class RoomRosterStore {
    static let shared = RoomRosterStore()
    private var models: [String: RoomRosterModel] = [:]
    func model(for projectId: String) -> RoomRosterModel {
        if let m = models[projectId] { return m }
        let m = RoomRosterModel(projectId: projectId)
        models[projectId] = m
        return m
    }
}
