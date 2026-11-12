import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, "Pane toggles": one button per side pane, drawn above the window so it can travel with the pane's edge.
// The bars it sits in (sidebar top bar, inspector top bar, the centre header's two ends) leave 28pt for it; this view
// supplies the button itself. Positions come from `PaneToggle` (SqueakMacCore).

struct PaneToggleOverlay: View {
    let leftOpen: Bool
    let rightOpen: Bool
    let showsRight: Bool
    let window: Double
    let sidebarWidth: Double
    let inspectorWidth: Double
    let toggleLeft: () -> Void
    let toggleRight: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack(alignment: .topLeading) {
            PaneToggleButton(side: .left, open: leftOpen, action: toggleLeft)
                .offset(x: PaneToggle.x(.left, open: leftOpen, window: window, inspectorWidth: inspectorWidth, fullScreen: model.conversationFullScreen, sidebarWidth: sidebarWidth), y: (Metrics.header - PaneToggle.size) / 2)
            if showsRight {
                PaneToggleButton(side: .right, open: rightOpen, action: toggleRight)
                    .offset(x: PaneToggle.x(.right, open: rightOpen, window: window, inspectorWidth: inspectorWidth, fullScreen: model.conversationFullScreen), y: (Metrics.header - PaneToggle.size) / 2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

struct PaneToggleButton: View {
    let side: PaneSide
    let open: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Lucide(side == .left ? .panelLeft : .panelRight, size: 16, color: open ? Theme.ink : Theme.muted)
                .frame(width: PaneToggle.size, height: PaneToggle.size)
                .background(hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .animation(Motion.quick, value: hovering)
        .accessibilityLabel(PaneToggle.label(side, open: open))
        .shortcutHint(PaneToggle.label(side, open: open), side == .left ? .toggleSidebar : .toggleInspector)
    }
}
