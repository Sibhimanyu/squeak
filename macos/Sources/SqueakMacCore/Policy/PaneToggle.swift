import Foundation

/// DESIGN.md §8.10, "Pane toggles": each side pane owns its toggle. Open, the button sits inside the pane's own top bar;
/// closed, it sits at the matching edge of the centre header, at the same height, and travels between the two with the
/// pane's edge. This is the placement logic only; the drawing is `PaneToggleOverlay`.
public enum PaneSide: Sendable, Hashable { case left, right }

public enum PaneToggleAnchor: Sendable, Hashable {
    /// At the trailing edge of the sidebar's top bar.
    case sidebarBar
    /// At the left of the centre header, after the traffic lights (the sidebar is closed).
    case centreLeading
    /// At the leading edge of the inspector's top bar.
    case inspectorBar
    /// At the right end of the centre header (the inspector is closed).
    case centreTrailing
}

public enum PaneToggle {
    /// The button is 28pt square, and the bars it lives in are the header's 44pt, so it never changes height.
    public static let size: Double = 28
    /// The traffic lights' clearance, and the bar's own side padding (Space.m): the left toggle's x, open or closed.
    public static let trafficLights: Double = 70
    public static let barPadding: Double = 12

    public static func anchor(_ side: PaneSide, open: Bool) -> PaneToggleAnchor {
        switch (side, open) {
        case (.left, true): .sidebarBar
        case (.left, false): .centreLeading
        case (.right, true): .inspectorBar
        case (.right, false): .centreTrailing
        }
    }

    /// Open toggles follow their pane's edge. The closed sidebar toggle leaves room for traffic lights.
    public static func x(_ side: PaneSide, open: Bool, window: Double, inspectorWidth: Double, fullScreen: Bool = false, sidebarWidth: Double = 256) -> Double {
        switch anchor(side, open: open) {
        case .sidebarBar: max(barPadding, sidebarWidth - barPadding - size)
        case .centreLeading: clearance(fullScreen: fullScreen) + barPadding
        case .inspectorBar: window - inspectorWidth + barPadding
        case .centreTrailing: window - barPadding - size
        }
    }

    /// The room the traffic lights take at the window's left: none in full screen, where macOS hides them.
    public static func clearance(fullScreen: Bool) -> Double { fullScreen ? 0 : trafficLights }

    /// Room a header leaves for a toggle that is sitting in it (nothing while the pane is open and holds it itself).
    public static func reserve(_ side: PaneSide, open: Bool) -> Double { open ? 0 : size }

    /// The icon is one glyph per side (Lucide panel-left / panel-right); state shows in its colour: `ink` open, `muted` closed.
    public static func label(_ side: PaneSide, open: Bool) -> String {
        switch side {
        case .left: open ? "Hide sidebar" : "Show sidebar"
        case .right: open ? "Hide inspector" : "Show inspector"
        }
    }

    public static func help(_ side: PaneSide, open: Bool) -> String { "\(label(side, open: open)) (\(shortcut(side)))" }

    /// The shortcut each toggle names (the registry holds the full map, including ⌘\ for the sidebar).
    public static func shortcut(_ side: PaneSide) -> String {
        let id: ShortcutID = side == .left ? .toggleSidebar : .toggleInspector
        return ShortcutRegistry.all.first { $0.id == id }?.chords.first?.display ?? ""
    }
}
