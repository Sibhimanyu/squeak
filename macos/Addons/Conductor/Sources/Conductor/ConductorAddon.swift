import Foundation
import Observation
import SqueakMacCore

/// The Conductor add-on for Squeak for Mac: reads Conductor's own database for the session list, shows the
/// workspaces Conductor has (the person ticks the ones Squeak should include) and opens a chat in Conductor.
/// It is inert until the daemon's `conductor` add-on is enabled (Settings › Add-ons); core only calls it then.
@MainActor
@Observable
public final class ConductorAddon: AppAddon {
    public nonisolated let id = "conductor"
    public nonisolated var hostName: String { "Conductor" }
    public nonisolated var providers: Set<String> { ["conductor"] }
    public nonisolated var mark: AgentMarkAsset? { .conductor }

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let database: ConductorDatabase
    @ObservationIgnored private let picks: ConductorPicksCache

    /// Conductor's workspaces as the daemon last listed them; nil before the first reading.
    public private(set) var workspaces: [ConductorWorkspaceItem]?
    public private(set) var problem: String?
    /// A development add-on's own link to Conductor (the relay); its page shows under this one.
    @ObservationIgnored public var link: (any ConductorLinkAddon)?

    public init(client: DaemonClient, database: ConductorDatabase = ConductorDatabase(), picks: ConductorPicksCache = ConductorPicksCache()) {
        self.client = client
        self.database = database
        self.picks = picks
    }

    // MARK: Sources

    public func sources(client: DaemonClient) -> AddonSources {
        Self.sources(client: client, database: database, picks: picks)
    }

    /// Normal case: `ConductorLocalAdapter` (reads Conductor's database, sends through the daemon) owns every
    /// Conductor chat and the daemon adapter serves none of them. If `conductor.db` is missing, the daemon
    /// adapter serves Conductor chats too (through the daemon), and opens them in Conductor.
    public static func sources(
        client: DaemonClient,
        database: ConductorDatabase = ConductorDatabase(),
        activityReader: ClaudeActivityReader = ClaudeActivityReader(),
        picks: ConductorPicksCache = ConductorPicksCache()
    ) -> AddonSources {
        guard database.exists else { return AddonSources(opener: Self.opener) }
        return AddonSources(
            adapters: [
                ConductorLocalAdapter(
                    database: database, activityReader: activityReader, sender: DaemonSender(client: client),
                    askSource: { await daemonAsks(client) },
                    pickedSource: { await picks.current(client: client) })
            ],
            takesOver: ["conductor"], opener: Self.opener)
    }

    /// `conductor://workspace?id=…&session=…`.
    public static let opener: DaemonAdapter.HostOpener = { provider, workspace, session in
        guard provider == "conductor", let workspace, let session else { return nil }
        var c = URLComponents()
        c.scheme = "conductor"
        c.host = "workspace"
        c.queryItems = [URLQueryItem(name: "id", value: workspace), URLQueryItem(name: "session", value: session)]
        return c.url
    }

    /// The daemon's view of each Conductor chat's closing question, by chat id; nil when it is not reachable.
    static func daemonAsks(_ client: DaemonClient) async -> [String: DaemonAskView]? {
        guard let state = try? await client.state() else { return nil }
        var out: [String: DaemonAskView] = [:]
        for d in state.sessions {
            guard let id = d.conductorSessionId, !id.isEmpty else { continue }
            out[id] = DaemonAskView(state: d.state, lastActivityAt: d.lastActivityAt, asks: d.asks)
        }
        return out
    }

    public nonisolated var watchedPaths: [String] {
        let path = ConductorDatabase.defaultPath
        return [path, path + "-wal"]
    }

    public nonisolated var iconReader: (@Sendable () -> [String: Data])? { { RepositoryIcons.read() } }

    public nonisolated var adapterNames: [String: String] { ["conductor-local": "Conductor database"] }

    // MARK: Connections

    public func connectionRows(health: [String: AdapterHealth]) -> [ConnectionsReport.Row] {
        [Self.databaseRow(exists: database.exists, localHealth: health["conductor-local"])]
    }

    public static func databaseRow(exists: Bool, localHealth: AdapterHealth?) -> ConnectionsReport.Row {
        let title = "Conductor database"
        guard exists else {
            return .init(title: title, value: "Missing", level: .problem,
                         detail: "Conductor's database was not found, so chats come from the Squeak service instead.")
        }
        guard let h = localHealth else { return .init(title: title, value: "Checking", level: .neutral) }
        switch h.status {
        case .connected: return .init(title: title, value: "Readable", level: .ok, detail: "Read-only. Squeak never writes to it.")
        case .degraded(let r): return .init(title: title, value: "Not readable", level: .problem, detail: r)
        default: return .init(title: title, value: "Not readable", level: .problem)
        }
    }

    public nonisolated var uninstallNote: String? { "Conductor is handed back first." }

    // MARK: Page: which workspaces to include

    public var page: AddonPage? {
        let rows = workspaces ?? []
        let choices = rows.map { w in
            AddonPage.Choice(
                id: w.id, title: w.name,
                subtitle: [w.branch.flatMap { $0.isEmpty || $0 == w.name ? nil : $0 }, w.chats == 1 ? "1 chat" : "\(w.chats) chats"]
                    .compactMap { $0 }.joined(separator: " · "),
                isOn: w.picked, group: w.repo, archived: w.isArchived,
                toggle: { [weak self] on in await self?.pick(w.id, on) })
        }
        return AddonPage(
            title: "Conductor", subtitle: "Choose the Conductor workspaces Squeak shows and answers.", symbol: "terminal",
            headline: workspaces == nil && problem == nil ? nil : .init(
                tone: problem == nil ? .good : .bad,
                text: problem ?? (database.exists ? "Reading Conductor's chats." : "Conductor's database wasn't found.")),
            notes: ["Only chats in ticked workspaces appear in Squeak. Nothing is changed in Conductor."],
            problem: problem, reportPlace: "Settings › Add-ons › Conductor",
            choicesTitle: "Workspaces", choices: choices,
            choicesEmpty: workspaces == nil ? "Looking for workspaces…" : "No workspaces yet. Open one in Conductor.")
    }

    public var extraPages: [AddonPage] { link.map { [$0.page] } ?? [] }

    public func refreshPage() async {
        await link?.refresh()
        do {
            guard let list = try await client.conductorWorkspaces() else {
                problem = "The Squeak service needs updating to list Conductor's workspaces."
                return
            }
            workspaces = list.workspaces
            problem = nil
        } catch {
            problem = "Couldn't read Conductor's workspaces: the Squeak service didn't answer."
        }
    }

    public func poll() async {
        await refreshPage()
        await link?.poll()
    }

    private func pick(_ id: String, _ on: Bool) async {
        do {
            if let list = try await client.setConductorWorkspace(id: id, picked: on) { workspaces = list.workspaces; problem = nil }
        } catch {
            problem = "Couldn't save that: the Squeak service didn't answer."
        }
    }
}
