import Foundation

/// Something a tab can be: one of the dockable panels, or an open file.
public enum DockItem: Equatable, Hashable, Sendable {
    case panel(DockPanel)
    case file(String)
    case terminal(UUID)
}

/// A dragged tab on the pasteboard: a prefixed string, so a chat tab's plain-string drag is never read as one.
public enum DockItemPayload {
    public static let filePrefix = "squeak-dock-file:"
    public static let terminalPrefix = "squeak-dock-terminal:"
    public static func encode(_ item: DockItem) -> String {
        switch item {
        case .panel(let p): return DockPanelPayload.encode(p)
        case .file(let path): return filePrefix + path
        case .terminal(let id): return terminalPrefix + id.uuidString
        }
    }
    public static func decode(_ text: String) -> DockItem? {
        if let p = DockPanelPayload.decode(text) { return .panel(p) }
        if text.hasPrefix(terminalPrefix) {
            return UUID(uuidString: String(text.dropFirst(terminalPrefix.count))).map { .terminal($0) }
        }
        guard text.hasPrefix(filePrefix) else { return nil }
        let path = String(text.dropFirst(filePrefix.count))
        return path.isEmpty ? nil : .file(path)
    }
}

/// Where open files sit when they are not in the centre. Not part of a saved workspace layout (a path belongs to one
/// project): it lives with the window's session, and a file that is no longer open is dropped (`pruned`).
/// The centre is implicit: a file with no placement is there. A side zone's selected file wins over its selected panel
/// until a panel is selected there.
public struct DockFiles: Equatable, Sendable {
    public private(set) var placed: [DockZone: [String]] = [:]
    public private(set) var selected: [DockZone: String] = [:]

    public init() {}

    public func zone(of path: String) -> DockZone {
        for z in [DockZone.right, .bottom] where placed[z]?.contains(path) == true { return z }
        return .centre
    }

    public func files(in zone: DockZone) -> [String] { zone == .centre ? [] : (placed[zone] ?? []) }

    /// Whether a side zone has files (so it shows even with no panels).
    public func hasFiles(in zone: DockZone) -> Bool { !files(in: zone).isEmpty }

    private mutating func detach(_ path: String) {
        for z in [DockZone.right, .bottom] {
            guard var list = placed[z], let i = list.firstIndex(of: path) else { continue }
            list.remove(at: i)
            placed[z] = list.isEmpty ? nil : list
            if selected[z] == path { selected[z] = list.isEmpty ? nil : list[min(i, list.count - 1)] }
        }
    }

    /// Puts a file in `zone`, before `before` (nil = at the end); the centre means "no placement". In a side zone it
    /// becomes that zone's selection.
    public mutating func move(_ path: String, to zone: DockZone, before: String? = nil) {
        let old = self.zone(of: path)
        let oldIndex = placed[old]?.firstIndex(of: path)
        detach(path)
        guard zone != .centre else { return }
        var list = placed[zone] ?? []
        if let before, before != path, let i = list.firstIndex(of: before) {
            list.insert(path, at: i)
        } else if before == path, old == zone, let oldIndex {
            list.insert(path, at: min(oldIndex, list.count))
        } else {
            list.append(path)
        }
        placed[zone] = list
        selected[zone] = path
    }

    /// The file closed: gone from every zone; a zone that showed it falls to the next file, else the previous, else its panel.
    public mutating func close(_ path: String) { detach(path) }

    public mutating func select(_ path: String) {
        let z = zone(of: path)
        if z != .centre { selected[z] = path }
    }

    /// A panel was selected in `zone`: it shows instead of the file.
    public mutating func deselect(_ zone: DockZone) { selected[zone] = nil }

    /// Only the files that are still open, in their places, each zone's selection kept valid.
    public func pruned(keeping open: Set<String>) -> DockFiles {
        var out = DockFiles()
        for z in [DockZone.right, .bottom] {
            let list = (placed[z] ?? []).filter(open.contains)
            guard !list.isEmpty else { continue }
            var seen = Set<String>()
            out.placed[z] = list.filter { seen.insert($0).inserted }
            if let s = selected[z], list.contains(s) { out.selected[z] = s }
        }
        return out
    }
}

public extension DockLayout {
    /// Like `isZoneVisible`, with files: a side zone that holds only files still shows.
    func isZoneVisible(_ zone: DockZone, files: DockFiles) -> Bool {
        isZoneVisible(zone) || files.hasFiles(in: zone)
    }
}

public extension DockBottomPlacement {
    static func of(_ layout: DockLayout, files: DockFiles) -> DockBottomPlacement {
        guard layout.isZoneVisible(.bottom, files: files) else { return .none }
        return layout.isZoneVisible(.right, files: files) && !layout.right.collapsed ? .underRight : .underCentre
    }
}
