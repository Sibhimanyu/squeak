import SqueakMacCore

/// The local project whose Duck, Dashboard or Room is under the strip.
@MainActor struct PondWorkspace {
    let pond: String
    let project: NativeProject

    init?(pond: String) {
        guard MacLayoutPreference.shared.isNew, let project = PondsModel.shared.native(key: pond),
              !project.id.isEmpty else { return nil }
        if let waiting = PondsModel.shared.pond(key: pond), PondStates.isGreyedRow(waiting) { return nil }
        self.pond = pond
        self.project = project
    }

    var roster: RoomRosterModel { RoomRosterStore.shared.model(for: project.id) }
    var threads: [RoomThread] { PondRoomStore.shared.model(for: project.id).feed.threads }

    func strip(place: DuckRowPlace, store: TabStore) -> PondWorkspaceStrip {
        PondWorkspaceStrip(
            roster: RoomRoster.roster(roster.ducks ?? threads.map(PondDuck.init(thread:)), threads: threads),
            place: place, items: store.pondItems(project.id), current: store.currentPondItem(project.id))
    }
}

extension AppModel {
    var pondWorkspace: PondWorkspace? {
        let key: String?
        switch location {
        case .pondHome(let pond): key = pond
        case .chat(let chat): key = session(chat).flatMap { PondsModel.shared.key(of: $0) }
        default: key = nil
        }
        return key.flatMap { PondWorkspace(pond: $0) }
    }

    var pondWorkspaceStrip: PondWorkspaceStrip? {
        guard let workspace = pondWorkspace else { return nil }
        let place = location.chatKey.flatMap { session($0) }.map(Self.duckRowPlace)
            ?? PondPageChrome.rowPlace(page: RoomViewPref.shared.mode(for: workspace.pond))
        return workspace.strip(place: place, store: tabStore)
    }

    static func duckRowPlace(_ session: HostSession) -> DuckRowPlace {
        .chat(sessionId: NativeAdapter.nativeId(session) ?? session.key.hostSessionId, duckId: session.duckId)
    }

    @discardableResult
    func openPondItem(_ item: TabItem) -> Bool {
        guard let workspace = pondWorkspace else { return false }
        let afterDuck = location.chatKey != nil
        updatePondItems(in: workspace.project.id) {
            $0.openPondItem(item, in: workspace.project.id, afterDuck: afterDuck)
        }
        if WorkPaneStore.shared.pane.shown != .terminal { WorkPaneStore.shared.close() }
        return true
    }

    func closePondItem(_ item: TabItem) {
        guard let workspace = pondWorkspace else { return }
        updatePondItems(in: workspace.project.id) { $0.closePondItem(item, in: workspace.project.id) }
    }

    /// Return to the Pond page or Duck underneath and keep the item open.
    func leavePondItem(pond: String) {
        guard let workspace = PondWorkspace(pond: pond), tabStore.currentPondItem(workspace.project.id) != nil else { return }
        updatePondItems(in: workspace.project.id) { $0.deselectPondItem(in: workspace.project.id) }
    }

    @discardableResult
    func closeCurrentPondItem() -> Bool {
        guard let workspace = pondWorkspace else { return false }
        updatePondItems(in: workspace.project.id) { $0.closeCurrentPondItem(in: workspace.project.id) }
        return true
    }

    func selectPondTab(_ tab: TabItem, in workspace: PondWorkspace, strip: PondWorkspaceStrip) {
        if tab.kind == .duck {
            guard let duck = strip.row.ducks.first(where: { $0.id == tab.id }), let sessionId = duck.sessionId else { return }
            openFromPond(.duck(sessionId), pond: workspace.pond, page: RoomViewPref.shared.mode(for: workspace.pond))
        } else {
            openPondItem(tab)
        }
    }

    func selectPondTab(_ tab: TabItem?) {
        guard let tab, let workspace = pondWorkspace, let strip = pondWorkspaceStrip else { return }
        selectPondTab(tab, in: workspace, strip: strip)
    }

    @discardableResult
    func stepPondTab(by delta: Int) -> Bool {
        guard let strip = pondWorkspaceStrip else { return false }
        selectPondTab(strip.step(by: delta))
        return true
    }

    @discardableResult
    func openPondFile(root: String, path: String) -> Bool {
        guard let workspace = pondWorkspace else { return false }
        let currentRoot = location.chatKey.flatMap { session($0)?.cwd } ?? workspace.project.rootPath
        guard root == currentRoot else { return false }
        return openPondItem(.pondFile(root: root, path: path))
    }

    @discardableResult
    func openPondDiff(session: HostSession, path: String?) -> Bool {
        guard let workspace = pondWorkspace, PondsModel.shared.key(of: session) == workspace.pond else { return false }
        let key = session.key.stringValue
        return openPondItem(path.map { .diff(session: key, path: $0) } ?? .reviewAll(session: key))
    }
}
