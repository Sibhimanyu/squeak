import Foundation

/// One tab in a stream's strip: a thread (its `SessionKey.stringValue`) or a file (its path in the stream's folder).
public struct StreamTab: Codable, Hashable, Sendable {
    public enum Kind: String, Codable, Sendable { case thread, file, artifact }
    public var kind: Kind
    public var id: String
    public init(_ kind: Kind, _ id: String) { self.kind = kind; self.id = id }
    public static func thread(_ id: String) -> StreamTab { StreamTab(.thread, id) }
    public static func file(_ id: String) -> StreamTab { StreamTab(.file, id) }
    /// An artifact opened as a tab; `id` is `ArtifactTabID.make`.
    public static func artifact(pond: String, path: String) -> StreamTab { StreamTab(.artifact, ArtifactTabID.make(pond: pond, path: path)) }
}

/// An artifact tab's id: its pond (directory key) and the file (an absolute path, or a remote pond's wire id).
public enum ArtifactTabID {
    private static let separator: Character = "\u{1F}"
    public static func make(pond: String, path: String) -> String { "\(pond)\(separator)\(path)" }
    public static func parse(_ id: String) -> (pond: String, path: String)? {
        guard let at = id.firstIndex(of: separator) else { return nil }
        return (String(id[..<at]), String(id[id.index(after: at)...]))
    }
}

/// The browser-window model of a stream's tab strip: per workspace, the ordered tabs and the selected one. It is
/// state of the app, not of the view, so leaving the stream (Home, the Dashboard, another pond, Settings) and coming
/// back finds the same tabs, and opening a thread from anywhere only ever adds a tab. Nothing here clears a set.
public struct StreamTabs: Codable, Equatable, Sendable {
    public struct Strip: Codable, Equatable, Sendable {
        public var tabs: [StreamTab] = []
        public var selected: StreamTab?
        /// The preview tab (at most one per stream): a file, artifact or canvas opened by a single click. A later
        /// single click replaces it; pinning (or a double-click) makes it a normal tab. Never a thread.
        public var preview: StreamTab?
    }

    private var strips: [String: Strip] = [:]
    public init() {}

    public func hasStrip(_ workspace: String) -> Bool { strips[workspace] != nil }
    public func tabs(_ workspace: String) -> [StreamTab] { strips[workspace]?.tabs ?? [] }
    public func selected(_ workspace: String) -> StreamTab? { strips[workspace]?.selected }

    /// The saved file tabs of a stream, in the order they sit among its threads.
    public func fileTabs(_ workspace: String) -> [String] {
        tabs(workspace).compactMap { $0.kind == .file ? $0.id : nil }
    }

    /// The saved artifact tabs of a stream, in the order they were opened (drawn after its threads and files).
    public func artifactTabs(_ workspace: String) -> [(pond: String, path: String)] {
        tabs(workspace).compactMap { $0.kind == .artifact ? ArtifactTabID.parse($0.id) : nil }
    }

    /// The strip as it is drawn: saved order, threads where `hasThread` says they resolve, files where `isOpen` says
    /// they are open; a file open but not saved yet goes last. Threads that are not saved are the caller's. Artifact
    /// tabs are not here: they are kept (`artifactTabs`) and drawn last.
    public func strip(_ workspace: String, hasThread: (String) -> Bool, isOpen: (String) -> Bool, openFiles: [String]) -> [StreamTab] {
        var out = tabs(workspace).filter { $0.kind == .artifact ? false : $0.kind == .thread ? hasThread($0.id) : isOpen($0.id) }
        let seen = Set(out.filter { $0.kind == .file }.map(\.id))
        out += openFiles.filter { !seen.contains($0) }.map(StreamTab.file)
        return out
    }

    /// Opens `tab` in the stream: appended after the selected tab when it is not there yet (a re-open only selects
    /// the one that is), then selected. `seed` is the strip a stream starts with the first time it is touched.
    public mutating func open(_ tab: StreamTab, in workspace: String, seed: [StreamTab] = []) {
        var strip = strips[workspace] ?? Strip(tabs: Self.unique(seed))
        if !strip.tabs.contains(tab) {
            if let sel = strip.selected, let at = strip.tabs.firstIndex(of: sel) { strip.tabs.insert(tab, at: at + 1) }
            else { strip.tabs.append(tab) }
        }
        strip.selected = tab
        strips[workspace] = strip
    }

    // MARK: Preview tab

    /// The stream's preview tab, if it has one.
    public func previewTab(_ workspace: String) -> StreamTab? { strips[workspace]?.preview }
    public func isPreview(_ tab: StreamTab, in workspace: String) -> Bool { strips[workspace]?.preview == tab }

    /// Opens `tab` as the stream's preview (a single click on a file, artifact or canvas). A tab already open (pinned
    /// or the preview itself) is only selected. Otherwise it takes the preview's slot, or is added after the selected
    /// tab when there is no preview. Threads are never previews: they open as normal tabs. Returns the tab that was
    /// replaced, so the caller can let go of what it showed.
    @discardableResult
    public mutating func openPreview(_ tab: StreamTab, in workspace: String, seed: [StreamTab] = []) -> StreamTab? {
        guard tab.kind != .thread else { open(tab, in: workspace, seed: seed); return nil }
        var strip = strips[workspace] ?? Strip(tabs: Self.unique(seed))
        if strip.tabs.contains(tab) { strip.selected = tab; strips[workspace] = strip; return nil }
        var replaced: StreamTab?
        if let old = strip.preview, let at = strip.tabs.firstIndex(of: old) {
            strip.tabs[at] = tab
            replaced = old
        } else if let sel = strip.selected, let at = strip.tabs.firstIndex(of: sel) { strip.tabs.insert(tab, at: at + 1) }
        else { strip.tabs.append(tab) }
        strip.preview = tab
        strip.selected = tab
        strips[workspace] = strip
        return replaced
    }

    /// Pins the preview tab (a double-click, "Keep open", an edit): it stays a normal tab and the next single click
    /// opens a new preview. Returns whether `tab` was the preview.
    @discardableResult
    public mutating func pin(_ tab: StreamTab, in workspace: String) -> Bool {
        guard var strip = strips[workspace], strip.preview == tab else { return false }
        strip.preview = nil
        strips[workspace] = strip
        return true
    }

    /// The tab of the thread shown in the centre always exists: added (and selected) when the strip lacks it, even if
    /// the list does not know the thread yet; a strip that has it only has its selection moved there. Returns whether
    /// anything changed.
    @discardableResult
    public mutating func ensureOpen(_ tab: StreamTab, in workspace: String, seed: [StreamTab] = []) -> Bool {
        if let strip = strips[workspace], strip.tabs.contains(tab), strip.selected == tab { return false }
        open(tab, in: workspace, seed: seed)
        return true
    }

    /// Selects a tab that is open; false when it is not.
    @discardableResult
    public mutating func select(_ tab: StreamTab, in workspace: String) -> Bool {
        guard var strip = strips[workspace], strip.tabs.contains(tab) else { return false }
        strip.selected = tab
        strips[workspace] = strip
        return true
    }

    /// Closes a tab. The selected tab's neighbour on the right is selected, else the left one; the last tab leaves
    /// the stream with nothing selected (its empty state). The strip itself stays, so it is not re-seeded.
    @discardableResult
    public mutating func close(_ tab: StreamTab, in workspace: String) -> StreamTab? {
        guard var strip = strips[workspace], let at = strip.tabs.firstIndex(of: tab) else { return strips[workspace]?.selected }
        strip.tabs.remove(at: at)
        if strip.preview == tab { strip.preview = nil }
        if strip.selected == tab {
            strip.selected = strip.tabs.isEmpty ? nil : strip.tabs[min(at, strip.tabs.count - 1)]
        }
        strips[workspace] = strip
        return strip.selected
    }

    /// A duck moved (ducks mode): its tab now opens `new`, in the same slot (not a close then an open, so nothing
    /// flickers); the selection follows when `old` was selected. A strip without `old` just opens `new`. Returns whether
    /// anything changed.
    @discardableResult
    public mutating func replace(_ old: StreamTab, with new: StreamTab, in workspace: String) -> Bool {
        guard old != new else { return false }
        guard var strip = strips[workspace], let at = strip.tabs.firstIndex(of: old) else {
            open(new, in: workspace)
            return true
        }
        let merged = strip.tabs.contains(new)
        if merged { strip.tabs.remove(at: at) } else { strip.tabs[at] = new }
        if strip.preview == old { strip.preview = merged || new.kind == .thread ? nil : new }
        if strip.selected == old { strip.selected = new }
        strips[workspace] = strip
        return true
    }

    /// Moves `source` to just before `target`.
    @discardableResult
    public mutating func move(_ source: StreamTab, before target: StreamTab, in workspace: String) -> Bool {
        guard var strip = strips[workspace], source != target,
              strip.tabs.contains(source), strip.tabs.contains(target) else { return false }
        strip.tabs.removeAll { $0 == source }
        guard let at = strip.tabs.firstIndex(of: target) else { return false }
        strip.tabs.insert(source, at: at)
        strips[workspace] = strip
        return true
    }

    /// Drops tabs whose thread is archived or deleted, or whose file is gone (`exists` says which still are). Run on
    /// restore; returns whether anything changed.
    @discardableResult
    public mutating func prune(exists: (StreamTab) -> Bool) -> Bool {
        var changed = false
        for (key, var strip) in strips {
            let kept = strip.tabs.filter(exists)
            guard kept.count != strip.tabs.count else { continue }
            if let sel = strip.selected, !kept.contains(sel) {
                let was = strip.tabs.firstIndex(of: sel) ?? 0
                strip.selected = strip.tabs[was...].first(where: kept.contains) ?? kept.last
            }
            strip.tabs = kept
            if let p = strip.preview, !kept.contains(p) { strip.preview = nil }
            strips[key] = strip
            changed = true
        }
        return changed
    }

    private static func unique(_ tabs: [StreamTab]) -> [StreamTab] {
        var seen = Set<StreamTab>()
        return tabs.filter { seen.insert($0).inserted }
    }
}
