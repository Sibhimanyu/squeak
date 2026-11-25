import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the slim icon rail on the right edge of a Duck's chat (and of a Pond's Room and Dashboard). One icon per work pane view; the selected one
// has the `selected` fill and a 3pt duck-yellow bar at the rail's edge; Changes carries the changed-file count.

struct WorkPaneRail: View {
    let scope: WorkPaneScope
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = WorkPaneStore.shared
        let duck = scope.key
        let shown = store.pane.current == duck ? store.pane.shown : nil
        let changed = scope.changesSession(model).flatMap { model.changesStore(for: $0.key.hostSessionId).changes?.files.count }
        VStack(spacing: 6) {
            tool(.changes, shown: shown, badge: WorkPaneMetrics.badge(count: changed))
            tool(.files, shown: shown)
            tool(.artifacts, shown: shown)
            if let workspace = model.pondWorkspace {
                let selected = model.tabStore.currentPondItem(workspace.project.id) == .notebook
                WorkPaneRailButton(title: "Notebook", symbol: "book.closed", selected: selected, badge: nil) {
                    model.openPondItem(.notebook)
                }
                .help("Open the Pond Notebook")
            }
            tool(.terminal, shown: shown)
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

    private func tool(_ view: WorkPaneView, shown: WorkPaneView?, badge: String? = nil) -> some View {
        WorkPaneRailButton(title: view.title, symbol: view.symbol, selected: shown == view, badge: badge) {
            WorkPaneStore.shared.toggle(view, duck: scope.key)
        }
        .help(shown == view ? "Close \(view.title)" : view.title)
    }
}

private struct WorkPaneRailButton: View {
    let title: String
    let symbol: String
    let selected: Bool
    let badge: String?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
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
        .accessibilityLabel(badge.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
