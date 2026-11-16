import Foundation

/// What is being dragged, as far as drop scoping cares. Each kind travels under its own pasteboard type
/// (`identifier`), so a target can say "acceptable" synchronously, before the drop, without reading the payload.
public enum DragKind: String, CaseIterable, Sendable {
    case pond, thread, panel, terminal, file
    /// A file-tree row dragged inside the Files browser (move/copy), not a tab.
    case fileToken

    public var identifier: String { "com.squeak.drag.\(rawValue)" }

    public static func of(_ item: DockItem) -> DragKind {
        switch item {
        case .thread: return .thread
        case .panel: return .panel
        case .terminal: return .terminal
        case .file: return .file
        }
    }
}

/// Where a drag may land. Only tab strips accept tabs; a pond only reorders in the sidebar's pond list; content
/// areas (transcript, composer, panel bodies) accept nothing.
public enum DragTarget: Hashable, Sendable {
    case centreStrip, rightStrip, bottomStrip
    /// The thin edge strip that appears while a tab is dragged and that side has no zone yet.
    case edgeStrip(DockZone)
    case pondList
    case fileTree

    public static func strip(_ zone: DockZone) -> DragTarget {
        switch zone {
        case .centre: return .centreStrip
        case .right: return .rightStrip
        case .bottom: return .bottomStrip
        }
    }
}

public enum DragScope {
    /// The four tab kinds: threads, panels, terminals and files all move between the three strips.
    public static let tabKinds: [DragKind] = [.thread, .panel, .terminal, .file]

    public static func allows(_ kind: DragKind, on target: DragTarget) -> Bool {
        switch target {
        case .centreStrip, .rightStrip, .bottomStrip, .edgeStrip: return tabKinds.contains(kind)
        case .pondList: return kind == .pond
        case .fileTree: return kind == .fileToken
        }
    }

    /// The kinds a target takes: what its `onDrop` lists, so nothing else ever highlights it.
    public static func accepted(by target: DragTarget) -> [DragKind] {
        DragKind.allCases.filter { allows($0, on: target) }
    }
}
