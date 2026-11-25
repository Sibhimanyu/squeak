import Foundation

/// The single owner of each Pond's tab list. Nothing else computes a strip: the view draws `tabs(pond)` as it is.
///
/// The rules (owner decisions T1 to T8):
/// - A Pond with no saved list has an empty strip. Squeak never adds a tab by itself (no seeding from recency, the live
///   list or the open chat); a tab exists because the person opened it.
/// - `open` switches to a tab that is already open (never a duplicate), else inserts the new one right after the current.
/// - A Duck is one tab, by its Duck id, so it follows the Duck to its newest chat. Closing a tab changes nothing else.
/// - A tab whose thing is gone closes itself (`prune`).
/// - One list per Pond, keyed by the Pond's id (its native project id, never a name), persisted under one key per Pond and
///   restored as it was left. An empty key means the Pond is not known yet: nothing is opened or saved under it.
public struct TabStore: Equatable, Sendable {
    public struct Strip: Codable, Equatable, Sendable {
        public var tabs: [TabItem] = []
        /// The tab the person is on (the last one opened or switched to); nil on the Dashboard or after closing the last.
        public var current: TabItem?
        /// The preview tab (at most one per Pond): a file, artifact or canvas opened by a single click. A later single
        /// click replaces it; pinning makes it a normal tab. Never a Duck.
        public var preview: TabItem?
        /// The new layout keeps its item tabs in the same Pond record, independently of the classic strip.
        fileprivate var workspaceItems: WorkspaceItems?
        /// A background item can arrive before an old classic strip has been placed in this Pond.
        fileprivate var workspaceOnly: Bool?
        public init(tabs: [TabItem] = [], current: TabItem? = nil, preview: TabItem? = nil) {
            self.tabs = tabs; self.current = current; self.preview = preview
        }
    }

    fileprivate struct WorkspaceItems: Codable, Equatable, Sendable {
        var tabs: [TabItem] = []
        var current: TabItem?
    }

    private var ponds: [String: Strip] = [:]
    /// Old strips waiting for their Pond's id (see `adoptLegacy`), by the name they were saved under.
    private var legacy: [String: Strip] = [:]
    public init() {}

    // MARK: Reading

    public func tabs(_ pond: String) -> [TabItem] { ponds[pond]?.tabs ?? [] }
    public func current(_ pond: String) -> TabItem? { ponds[pond]?.current }
    public func contains(_ tab: TabItem, in pond: String) -> Bool { ponds[pond]?.tabs.contains(tab) == true }
    public func previewTab(_ pond: String) -> TabItem? { ponds[pond]?.preview }
    public func isPreview(_ tab: TabItem, in pond: String) -> Bool { ponds[pond]?.preview == tab }

    /// The saved file tabs of a Pond, in strip order.
    public func fileTabs(_ pond: String) -> [String] { tabs(pond).compactMap { $0.kind == .file ? $0.id : nil } }

    public func pondItems(_ pond: String) -> [TabItem] { ponds[pond]?.workspaceItems?.tabs ?? [] }
    public func currentPondItem(_ pond: String) -> TabItem? { ponds[pond]?.workspaceItems?.current }

    /// Ducks precede every item. A new item opened from the Dashboard, the Room or a Duck (no item is current) goes first among
    /// the items; one opened from an item tab goes right after that tab. `afterDuck` is kept for callers and changes nothing:
    /// every page without a current item behaves the same way.
    public mutating func openPondItem(_ item: TabItem, in pond: String, focus: Bool = true, afterDuck: Bool = false) {
        guard !pond.isEmpty, item.isPondItem else { return }
        var strip = ponds[pond] ?? Strip()
        if ponds[pond] == nil { strip.workspaceOnly = true }
        var items = strip.workspaceItems ?? WorkspaceItems()
        Self.insert(item, into: &items.tabs, after: items.current, otherwiseFirst: true)
        if focus { items.current = item }
        strip.workspaceItems = items
        ponds[pond] = strip
    }

    public mutating func deselectPondItem(in pond: String) {
        ponds[pond]?.workspaceItems?.current = nil
    }

    @discardableResult
    public mutating func closeCurrentPondItem(in pond: String) -> Bool {
        guard let item = currentPondItem(pond) else { return false }
        return closePondItem(item, in: pond)
    }

    /// Closing chooses the next item, then the previous one. With neither, the Pond page or Duck underneath resumes.
    @discardableResult
    public mutating func closePondItem(_ item: TabItem, in pond: String) -> Bool {
        guard var items = ponds[pond]?.workspaceItems, let index = items.tabs.firstIndex(of: item) else { return false }
        if items.current == item { items.current = Self.neighbour(of: index, in: items.tabs) }
        items.tabs.remove(at: index)
        ponds[pond]?.workspaceItems = items
        return true
    }

    // MARK: Opening and closing

    /// Opens `item`: switches to it when it is already open, else inserts it right after the current tab (at the end when
    /// there is none). It becomes the current tab.
    public mutating func open(_ item: TabItem, in pond: String) {
        guard !pond.isEmpty else { return }
        var strip = ponds[pond] ?? Strip()
        strip.workspaceOnly = nil
        Self.insert(item, into: &strip.tabs, after: strip.current)
        strip.current = item
        ponds[pond] = strip
    }

    /// Opens `item` as the Pond's preview (a single click on a file, artifact or canvas). A tab already open is only
    /// switched to. Otherwise it takes the preview's slot, or goes after the current tab. A Duck or duckling is never a
    /// preview: it opens normally. Returns the preview it replaced, so the caller can let go of what it showed.
    @discardableResult
    public mutating func openPreview(_ item: TabItem, in pond: String) -> TabItem? {
        guard !pond.isEmpty else { return nil }
        guard item.kind == .file || item.kind == .artifact else { open(item, in: pond); return nil }
        var strip = ponds[pond] ?? Strip()
        strip.workspaceOnly = nil
        if strip.tabs.contains(item) { strip.current = item; ponds[pond] = strip; return nil }
        var replaced: TabItem?
        if let old = strip.preview, let at = strip.tabs.firstIndex(of: old) {
            strip.tabs[at] = item
            replaced = old
        } else {
            Self.insert(item, into: &strip.tabs, after: strip.current)
        }
        strip.preview = item
        strip.current = item
        ponds[pond] = strip
        return replaced
    }

    /// Pins the preview (a double-click, "Keep open", an edit): it stays a normal tab. Whether `item` was the preview.
    @discardableResult
    public mutating func pin(_ item: TabItem, in pond: String) -> Bool {
        guard var strip = ponds[pond], strip.preview == item else { return false }
        strip.preview = nil
        ponds[pond] = strip
        return true
    }

    /// Makes an open tab the current one; false when it is not open.
    @discardableResult
    public mutating func select(_ item: TabItem, in pond: String) -> Bool {
        guard var strip = ponds[pond], strip.tabs.contains(item) else { return false }
        guard strip.current != item else { return true }
        strip.current = item
        ponds[pond] = strip
        return true
    }

    /// Closes a tab and only that: the list is otherwise untouched. When it was current, its right neighbour becomes
    /// current, else the left one, else none. Returns the current tab afterwards.
    @discardableResult
    public mutating func close(_ item: TabItem, in pond: String) -> TabItem? {
        guard var strip = ponds[pond], let at = strip.tabs.firstIndex(of: item) else { return ponds[pond]?.current }
        if strip.current == item { strip.current = Self.neighbour(of: at, in: strip.tabs) }
        strip.tabs.remove(at: at)
        if strip.preview == item { strip.preview = nil }
        ponds[pond] = strip
        return strip.current
    }

    /// Moves `source` to the landing (before or after its anchor), decided by `TabDrop`. False when either tab is not in
    /// the list or nothing would change.
    @discardableResult
    public mutating func move(_ source: TabItem, to landing: TabDrop.Landing<TabItem>, in pond: String) -> Bool {
        guard var strip = ponds[pond], source != landing.anchor,
              strip.tabs.contains(source), strip.tabs.contains(landing.anchor) else { return false }
        let moved = TabDrop.applying(landing, moving: source, in: strip.tabs)
        guard moved != strip.tabs else { return false }
        strip.tabs = moved
        ponds[pond] = strip
        return true
    }

    // MARK: Things that go away

    /// Closes every tab whose thing no longer exists (`exists` says which do): a deleted Duck, a removed file, a gone
    /// canvas. Returns the Ponds that changed.
    @discardableResult
    public mutating func prune(exists: (TabItem) -> Bool) -> [String] {
        var changed: [String] = []
        for pond in Array(ponds.keys) {
            let gone = tabs(pond).filter { !exists($0) }
            for tab in gone { close(tab, in: pond) }
            if !gone.isEmpty { changed.append(pond) }
        }
        return changed
    }

    /// Turns `chat:<key>` Duck identities into Duck ids as the chats are learned (`duckOf` gives a chat's Duck id, nil when
    /// it has none or is not known yet). A Duck that already has a tab absorbs the duplicate. Returns the Ponds that changed.
    @discardableResult
    public mutating func adoptDucks(duckOf: (String) -> String?) -> [String] {
        var changed: [String] = []
        for (pond, var strip) in ponds {
            func rename(_ t: TabItem) -> TabItem {
                guard let key = t.chatKey, let duck = duckOf(key) else { return t }
                return .duck(duck)
            }
            var seen = Set<TabItem>()
            let tabs = strip.tabs.map(rename).filter { seen.insert($0).inserted }
            let current = strip.current.map(rename), preview = strip.preview.map(rename)
            guard tabs != strip.tabs || current != strip.current || preview != strip.preview else { continue }
            strip.tabs = tabs; strip.current = current; strip.preview = preview
            ponds[pond] = strip
            changed.append(pond)
        }
        return changed
    }

    /// Gives each old Ducks strip to its Pond once the Pond is known: the Pond of the first chat in the strip that `pondOf`
    /// can place (by id, never by name). A strip whose Pond already has a list is dropped; one with no chat placed yet waits.
    /// Saves the Pond lists and forgets the old keys in `defaults`. Returns the Ponds that got a list.
    @discardableResult
    public mutating func adoptLegacy(in defaults: UserDefaults, pondOf: (String) -> String?) -> [String] {
        var adopted: [String] = []
        for (name, strip) in legacy {
            if strip.tabs.isEmpty { legacy[name] = nil; defaults.removeObject(forKey: Self.legacyPondKey(name)); continue }
            var found: String?
            for t in strip.tabs { if let key = t.chatKey, let p = pondOf(key), !p.isEmpty { found = p; break } }
            guard let pond = found else { continue }
            if ponds[pond] == nil || ponds[pond]?.workspaceOnly == true {
                var merged = strip
                merged.workspaceItems = ponds[pond]?.workspaceItems
                ponds[pond] = merged
                save(pond: pond, to: defaults)
                adopted.append(pond)
            }
            legacy[name] = nil
            defaults.removeObject(forKey: Self.legacyPondKey(name))
        }
        return adopted
    }

    private static func insert(_ item: TabItem, into tabs: inout [TabItem], after current: TabItem?, otherwiseFirst: Bool = false) {
        guard !tabs.contains(item) else { return }
        let index = current.flatMap { tabs.firstIndex(of: $0) }.map { $0 + 1 } ?? (otherwiseFirst ? 0 : tabs.count)
        tabs.insert(item, at: index)
    }

    private static func neighbour(of index: Int, in tabs: [TabItem]) -> TabItem? {
        if tabs.indices.contains(index + 1) { return tabs[index + 1] }
        return index > 0 ? tabs[index - 1] : nil
    }
}

// MARK: Persistence: one key per Pond

public extension TabStore {
    static let keyPrefix = "tabs.pond."
    static let migratedKey = "tabs.migrated.v2"
    /// The previous app's one blob of per-stream strips, read once by `migrate`.
    static let legacyKey = "streamTabs"

    static func defaultsKey(_ pond: String) -> String { keyPrefix + pond }
    /// Where an old Ducks strip waits, by the name it was saved under, until its Pond's id is known.
    static let legacyPrefix = "tabs.legacy."
    static func legacyPondKey(_ name: String) -> String { legacyPrefix + name }

    /// The lists saved in `defaults`, one per Pond. The first time, the old strips are migrated (and the old key dropped).
    init(restoring defaults: UserDefaults) {
        self.init()
        if !defaults.bool(forKey: Self.migratedKey) {
            if let data = defaults.data(forKey: Self.legacyKey) {
                for (name, strip) in Self.migrate(legacy: data) {
                    legacy[name] = strip
                    if let blob = try? JSONEncoder().encode(strip) { defaults.set(blob, forKey: Self.legacyPondKey(name)) }
                }
            }
            defaults.removeObject(forKey: Self.legacyKey)
            defaults.set(true, forKey: Self.migratedKey)
        }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.legacyPrefix) {
            guard let data = defaults.data(forKey: key), let strip = try? JSONDecoder().decode(Strip.self, from: data) else { continue }
            legacy[String(key.dropFirst(Self.legacyPrefix.count))] = strip
        }
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(Self.keyPrefix) {
            guard let data = defaults.data(forKey: key), let strip = try? JSONDecoder().decode(Strip.self, from: data) else { continue }
            ponds[String(key.dropFirst(Self.keyPrefix.count))] = strip
        }
    }

    /// Writes one Pond's list (its key only).
    func save(pond: String, to defaults: UserDefaults) {
        guard let strip = ponds[pond], let data = try? JSONEncoder().encode(strip) else { return }
        defaults.set(data, forKey: Self.defaultsKey(pond))
    }

    /// The old saved strips, by the name they were saved under. Only a Pond's Ducks strip (workspace id `<name>/ducks`)
    /// survives, its chats as `chat:<key>` Duck identities (`adoptDucks` turns those into Duck ids); per-stream strips are
    /// dropped. The name only holds the strip: `adoptLegacy` finds the Pond through the chats' placement.
    static func migrate(legacy data: Data) -> [String: Strip] {
        struct Old: Decodable {
            struct Tab: Decodable { var kind: String; var id: String }
            struct OldStrip: Decodable { var tabs: [Tab] = []; var selected: Tab?; var preview: Tab? }
            var strips: [String: OldStrip]
        }
        guard let old = try? JSONDecoder().decode(Old.self, from: data) else { return [:] }
        func item(_ t: Old.Tab) -> TabItem? {
            switch t.kind {
            case "thread": .duck(TabItem.chatPrefix + t.id)
            case "file": .file(t.id)
            case "artifact": TabItem(.artifact, t.id)
            default: nil
            }
        }
        var out: [String: Strip] = [:]
        for (workspace, strip) in old.strips where workspace.hasSuffix("/ducks") {
            let pond = String(workspace.dropLast("/ducks".count))
            guard !pond.isEmpty else { continue }
            var seen = Set<TabItem>()
            let tabs = strip.tabs.compactMap(item).filter { seen.insert($0).inserted }
            out[pond] = Strip(tabs: tabs,
                              current: strip.selected.flatMap(item).flatMap { tabs.contains($0) ? $0 : nil },
                              preview: strip.preview.flatMap(item).flatMap { tabs.contains($0) ? $0 : nil })
        }
        return out
    }
}
