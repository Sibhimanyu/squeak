import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the slim icon rail on the right edge of a Duck's chat. One icon per work pane view; the selected one
// has the `selected` fill and a 3pt duck-yellow bar at the rail's edge; Changes carries the changed-file count.

struct WorkPaneRail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = WorkPaneStore.shared
        let duck = WorkPaneActions.duckKey(session)
        let shown = store.pane.current == duck ? store.pane.shown : nil
        let changed = model.changesStore(for: session.key.hostSessionId).changes?.files.count
        VStack(spacing: 6) {
            ForEach(WorkPaneView.allCases) { view in
                WorkPaneRailButton(view: view, selected: shown == view, badge: view == .changes ? WorkPaneMetrics.badge(count: changed) : nil) {
                    store.toggle(view, duck: duck)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, Space.s)
        .frame(width: WorkPaneMetrics.railWidth)
        .frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Work pane")
    }
}

private struct WorkPaneRailButton: View {
    let view: WorkPaneView
    let selected: Bool
    let badge: String?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: view.symbol)
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(selected || hovering ? Theme.ink : Theme.muted)
                .frame(width: 40, height: 40)
                .background(selected ? Theme.selected : (hovering ? Theme.selected.opacity(0.5) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(alignment: .topTrailing) {
                    if let badge {
                        Text(badge).font(.system(size: 10, weight: .semibold)).monospacedDigit().foregroundStyle(Theme.ink)
                            .padding(.horizontal, 4).frame(minWidth: 16, minHeight: 16)
                            .background(Theme.duck, in: Capsule())
                            .offset(x: 4, y: -2)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            if selected { Capsule().fill(Theme.duck).frame(width: 3, height: 22).offset(x: -1) }
        }
        .frame(width: WorkPaneMetrics.railWidth)
        .onHover { hovering = $0 }
        .animation(Motion.quick, value: hovering)
        .animation(Motion.quick, value: selected)
        .help(selected ? "Close \(view.title)" : view.title)
        .accessibilityLabel(badge.map { "\(view.title), \($0)" } ?? view.title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
