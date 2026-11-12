import Foundation

// Squeak for Mac's add-on contract. An add-on is a SwiftPM target (macos/Addons/<Name>) that describes what it
// contributes (sources for the session list, a settings page, rows for Connections, ...) and is inert until the
// person adds it in Settings › Extensions. Core knows only the types here: it never names a host app, and it draws
// whatever an enabled add-on describes. Whether an add-on is enabled is the daemon's word (`/control/addons`).

/// One entry of `GET /control/addons`.
public struct AddonInfo: Decodable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var blurb: String
    /// Can be switched on on this Mac (the host app is there).
    public var available: Bool
    public var enabled: Bool

    public init(id: String, name: String, blurb: String = "", available: Bool = true, enabled: Bool = false) {
        self.id = id; self.name = name; self.blurb = blurb; self.available = available; self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey { case id, name, blurb, available, enabled }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        blurb = (try? c.decode(String.self, forKey: .blurb)) ?? ""
        available = (try? c.decode(Bool.self, forKey: .available)) ?? true
        enabled = (try? c.decode(Bool.self, forKey: .enabled)) ?? false
    }
}

/// What an enabled add-on adds to the session list.
public struct AddonSources: Sendable {
    public var adapters: [any HostAdapter]
    /// Providers (`SessionKey.provider`) the adapters above serve themselves: the daemon adapter drops its rows for these.
    public var takesOver: Set<String>
    /// How the add-on's host app opens one of its chats, for the daemon adapter when it serves them.
    public var opener: DaemonAdapter.HostOpener?

    public init(adapters: [any HostAdapter] = [], takesOver: Set<String> = [], opener: DaemonAdapter.HostOpener? = nil) {
        self.adapters = adapters; self.takesOver = takesOver; self.opener = opener
    }
}

/// An add-on. Everything defaults to "contributes nothing", so a new add-on states only what it adds.
@MainActor
public protocol AppAddon: AnyObject {
    /// The daemon's id for it (`/control/addons`).
    var id: String { get }
    /// The host app's name, for the sentences core says about its chats ("Open in …").
    var hostName: String { get }
    /// Providers (`SessionKey.provider`) of the chats its host owns.
    var providers: Set<String> { get }
    /// The host app's own mark, drawn beside the add-on and on its chats.
    var mark: AgentMarkAsset? { get }
    /// What it does, in a sentence, when the daemon's catalogue has none.
    var summary: String { get }
    /// What the session list reads from it.
    func sources(client: DaemonClient) -> AddonSources
    /// Files whose changes mean the sources have something new (watched while enabled).
    var watchedPaths: [String] { get }
    /// Reads the host's own project artwork (repository name to image data); runs off the main thread, only while on.
    var iconReader: (@Sendable () -> [String: Data])? { get }
    /// Display names for the adapters it adds, in diagnostics.
    var adapterNames: [String: String] { get }
    /// Rows for Settings › Connections.
    func connectionRows(health: [String: AdapterHealth]) -> [ConnectionsReport.Row]
    /// Its settings page, shown under its row in Settings › Extensions once it is on. Read in a view body.
    var page: AddonPage? { get }
    /// More pages under the first (a development add-on's own link), same place.
    var extraPages: [AddonPage] { get }
    /// Reads whatever the page shows; runs when the add-on turns on and while its page is open.
    func refreshPage() async
    /// Runs while its page is on screen, until cancelled (refreshes, then keeps a development link's own poll going).
    func poll() async
    /// A sentence for the uninstall sheet ("Conductor is handed back first."), or nil.
    var uninstallNote: String? { get }
}

public extension AppAddon {
    var providers: Set<String> { [] }
    var mark: AgentMarkAsset? { nil }
    var summary: String { "" }
    func sources(client: DaemonClient) -> AddonSources { AddonSources() }
    var watchedPaths: [String] { [] }
    var iconReader: (@Sendable () -> [String: Data])? { nil }
    var adapterNames: [String: String] { [:] }
    func connectionRows(health: [String: AdapterHealth]) -> [ConnectionsReport.Row] { [] }
    var page: AddonPage? { nil }
    var extraPages: [AddonPage] { [] }
    func refreshPage() async {}
    func poll() async { await refreshPage() }
    var uninstallNote: String? { nil }
}

/// Which sources serve the session list: Squeak's own chats, the add-ons' (when enabled), then the daemon's.
public enum SessionSources {
    @MainActor
    public static func adapters(client: DaemonClient, native: NativeHostClient? = nil, addons: [any AppAddon] = []) -> [any HostAdapter] {
        // Squeak's own chats come first, so their keys are owned by the adapter that has the transcript, the
        // diffs and the controls; the daemon adapter's row for the same chat is then a duplicate the broker drops.
        let own: [any HostAdapter] = native.map { [NativeAdapter(host: $0, daemon: client)] } ?? []
        var contributed: [any HostAdapter] = []
        var takesOver = Set<String>()
        var opener: DaemonAdapter.HostOpener?
        for addon in addons {
            let s = addon.sources(client: client)
            contributed += s.adapters
            takesOver.formUnion(s.takesOver)
            opener = opener ?? s.opener
        }
        return own + contributed + [DaemonAdapter(client: client, excluding: takesOver, opener: opener)]
    }
}

extension DaemonClient {
    /// Every add-on the daemon carries. Nil from a daemon that predates add-ons.
    public func addons() async throws -> [AddonInfo]? {
        let r = try await getControl("/control/addons")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        struct Body: Decodable { var addons: [Failable<AddonInfo>]? }
        return try decode(Body.self, r.body).addons?.compactMap(\.value)
    }

    /// Turns an add-on on or off; the daemon answers with the catalogue as it is then.
    public func setAddon(id: String, enabled: Bool) async throws -> [AddonInfo]? {
        struct Request: Encodable { let id: String; let enabled: Bool }
        let r = try await postControl("/control/addons", body: try JSONEncoder().encode(Request(id: id, enabled: enabled)))
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        struct Body: Decodable { var addons: [Failable<AddonInfo>]? }
        return try decode(Body.self, r.body).addons?.compactMap(\.value)
    }
}
