import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Window-owned navigation survives sidebar collapse, including keyboard navigation.
struct WorkbenchNavigation: View {
    let sidebarHidden: Bool
    @Environment(AppModel.self) private var model
    @State private var history = NavHistory<WorkbenchPlace>()
    @State private var navigating = false

    /// Two 28pt buttons, their spacing, and the gap after the collapsed sidebar toggle.
    static let reserve: Double = 64

    private var currentPlace: WorkbenchPlace? {
        NewChatController.shared.page == .create ? .create : model.selected.map { .chat($0) }
    }

    var body: some View {
        HStack(spacing: 4) {
            button(.arrowLeft, "Back (⌘[)", enabled: history.canGoBack, action: goBack)
            button(.arrowRight, "Forward (⌘])", enabled: history.canGoForward, action: goForward)
        }
        .offset(x: PaneToggle.clearance(fullScreen: model.conversationFullScreen) + PaneToggle.barPadding
                + (sidebarHidden ? PaneToggle.size + 4 : 4),
                y: (Metrics.header - PaneToggle.size) / 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onChange(of: currentPlace) { _, place in
            if navigating { navigating = false } else { history.visit(place) }
        }
        .onAppear { history.visit(currentPlace) }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateBack)) { _ in goBack() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateForward)) { _ in goForward() }
    }

    private func button(_ icon: LucideName, _ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(icon, size: 16, color: enabled ? Theme.muted : Theme.subtle.opacity(0.5))
                .frame(width: PaneToggle.size, height: PaneToggle.size).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).help(label).accessibilityLabel(label)
    }

    private func goBack() { if let place = history.back() { open(place) } }
    private func goForward() { if let place = history.forward() { open(place) } }

    private func open(_ place: WorkbenchPlace?) {
        PondsModel.shared.route = nil
        navigating = currentPlace != place
        switch place {
        case .create?: NewChatController.shared.showCreate()
        case .chat(let key)?:
            if model.sessions.contains(where: { $0.key == key }) { model.select(key) }
            else { WorkbenchNav.goHome(model) }
        case nil: WorkbenchNav.goHome(model)
        }
    }
}
