import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the one slim icon rail on the right edge of the Dashboard, the Room and every Duck. One icon per tool
// (`RailTool`); the selected one (open list, current tab or shown pane) has the `selected` fill and a 3pt duck-yellow bar at
// the rail's edge; Changes carries the changed-file count.

struct WorkPaneRail: View {
    let scope: WorkPaneScope
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = WorkPaneStore.shared
        let popovers = RailPopoverState.shared
        let shown = store.pane.current == scope.key ? store.pane.shown : nil
        VStack(spacing: CGFloat(RailMetrics.spacing)) {
            // Flow per icon: Changes, Files and Artifacts open a one-shot list under the icon (pick an item: it opens as a tab);
            // Tasks opens a one-shot list of open Tasks (pick one: its Duck opens); Notebook opens the Pond Notebook as a tab;
            // Terminal opens or closes the side pane.
            ForEach(RailTool.shown) { tool in
                switch tool.opens {
                case .popover:
                    RailButton(title: tool.title, symbol: tool.symbol, selected: popovers.isOpen(tool), badge: badge(tool)) {
                        popovers.toggle(tool)
                    }
                    .help(tool.title)
                    .popover(isPresented: Binding(get: { popovers.isOpen(tool) }, set: { popovers.set(tool, open: $0) }), arrowEdge: .leading) {
                        popover(tool)
                    }
                case .tab:
                    let selected = model.pondWorkspace.map { model.tabStore.currentPondItem($0.project.id) == .notebook } ?? false
                    RailButton(title: tool.title, symbol: tool.symbol, selected: selected, badge: nil) { model.openPondItem(.notebook) }
                        .help("Open the Pond Notebook")
                case .pane:
                    RailButton(title: tool.title, symbol: tool.symbol, selected: shown == .terminal, badge: nil) {
                        WorkPaneStore.shared.toggle(.terminal, duck: scope.key)
                    }
                    .help(shown == .terminal ? "Close Terminal" : "Terminal")
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.top, CGFloat(RailMetrics.topPadding))
        .frame(width: WorkPaneMetrics.railWidth)
        .frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Rail")
        // The Pond-wide count behind the Changes badge is read now and then while the window shows this page.
        .task(id: scope.key) {
            guard scope.isPond else { return }
            while !Task.isCancelled {
                if model.windowVisible { await RailChangesSource.refresh(scope: scope, model: model) }
                try? await Task.sleep(for: .seconds(20))
            }
        }
        // The page changed: a list belongs to the page it was opened on.
        .onChange(of: scope.key) { RailPopoverState.shared.close() }
    }

    private func badge(_ tool: RailTool) -> String? {
        guard tool == .changes else { return nil }
        return WorkPaneMetrics.badge(count: RailChanges.total(RailChangesSource.sections(scope: scope, model: model)))
    }

    @ViewBuilder private func popover(_ tool: RailTool) -> some View {
        let close = { RailPopoverState.shared.close() }
        switch tool {
        case .changes: RailChangesPopover(scope: scope, close: close)
        case .files: RailFilesPopover(scope: scope, close: close)
        case .artifacts: RailArtifactsPopover(scope: scope, close: close)
        case .tasks: RailTasksPopover(close: close)
        case .notebook, .terminal: EmptyView()
        }
    }
}

private struct RailButton: View {
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
