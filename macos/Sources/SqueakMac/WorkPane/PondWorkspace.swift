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
            roster: RoomRoster.roster(roster.list, threads: threads),
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
        RailRecentStore.shared.note(item, in: workspace.project.id)
        RailPopoverState.shared.close()
        return true
    }

    func closePondItem(_ item: TabItem) {
        guard let workspace = pondWorkspace else { return }
        let wasCurrent = tabStore.currentPondItem(workspace.project.id) == item
        updatePondItems(in: workspace.project.id) { $0.closePondItem(item, in: workspace.project.id) }
        if wasCurrent { returnToParent(of: item, pond: workspace.pond) }
    }

    /// Closing a Duckling's tab shows its parent Duck's chat again.
    private func returnToParent(of item: TabItem, pond: String) {
        guard let source = item.ducklingSource, let key = SessionKey(stringValue: source.session), session(key) != nil else { return }
        openFromPond(key, pond: pond, page: RoomViewPref.shared.mode(for: pond))
    }

    /// Opens a Duckling as a tab right after its parent Duck's, over the parent's chat. False when the new layout has no Pond
    /// for the chat (the classic dock then shows it).
    @discardableResult
    func openDuckling(_ ref: DucklingRef) -> Bool {
        guard let parent = session(ref.session), let pond = PondsModel.shared.key(of: parent), let workspace = PondWorkspace(pond: pond),
              WorkPaneActions.isDuckView(parent) else { return false }
        let page = RoomViewPref.shared.mode(for: pond)
        let tab = TabItem.duckling(session: ref.session.stringValue, task: ref.taskId, parentDuck: parent.duckId ?? parent.key.stringValue)
        // The parent's chat first (the one source of truth for what the centre shows is PondCentre), then the pill over it.
        applyCentre(pond: pond, openDuck: { _ in openFromPond(ref.session, pond: pond, page: page) }) { $0.deepLink(duck: tab.parentDuck ?? "") }
        if selectedSession?.key != ref.session { openFromPond(ref.session, pond: pond, page: page) }
        updatePondItems(in: workspace.project.id) { $0.openPondItem(tab, in: workspace.project.id) }
        RailPopoverState.shared.close()
        return true
    }

    /// Opens a Duckling in the new layout's strip, else in the classic dock.
    func openDucklingAnywhere(_ ref: DucklingRef) {
        if !openDuckling(ref) { DockStore.shared.openDuckling(ref) }
    }

    func isDucklingOpen(_ ref: DucklingRef) -> Bool {
        guard let parent = session(ref.session), let pond = PondsModel.shared.key(of: parent), let workspace = PondWorkspace(pond: pond) else {
            return DockStore.shared.ducklings.selected[DockStore.shared.ducklings.zone(of: ref) ?? .centre] == ref
        }
        return tabStore.currentPondItem(workspace.project.id)?.ducklingSource.map { $0.session == ref.session.stringValue && $0.task == ref.taskId } == true
    }

    /// Esc on a Duckling's tab: back to the chat of the Duck that started it.
    func escapeCentre(pond: String) {
        let item = PondWorkspace(pond: pond).flatMap { tabStore.currentPondItem($0.project.id) }
        applyCentre(pond: pond, openDuck: { _ in
            if let item { returnToParent(of: item, pond: pond) }
        }) { $0.escape() }
    }

    /// Return to the Pond page or Duck underneath and keep the item open.
    func leavePondItem(pond: String) {
        guard let workspace = PondWorkspace(pond: pond), tabStore.currentPondItem(workspace.project.id) != nil else { return }
        updatePondItems(in: workspace.project.id) { $0.deselectPondItem(in: workspace.project.id) }
    }

    @discardableResult
    func closeCurrentPondItem() -> Bool {
        guard let workspace = pondWorkspace else { return false }
        guard let item = tabStore.currentPondItem(workspace.project.id) else { return true }
        closePondItem(item)
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
    func openPondDiff(session: HostSession, path: String?, stream: TabStream? = nil) -> Bool {
        guard let workspace = pondWorkspace, PondsModel.shared.key(of: session) == workspace.pond else { return false }
        let key = session.key.stringValue
        return openPondItem(path.map { .diff(session: key, path: $0, stream: stream) } ?? .reviewAll(session: key, stream: stream))
    }
}
