import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Window-owned navigation survives sidebar collapse, including keyboard navigation.
struct WorkbenchNavigation: View {
    let sidebarHidden: Bool
    @Environment(AppModel.self) private var model

    /// Two 28pt buttons, their spacing, and the gap after the collapsed sidebar toggle.
    static let reserve: Double = 64

    var body: some View {
        HStack(spacing: 4) {
            button(.arrowLeft, "Back (⌘[)", enabled: model.navHistory.canGoBack, action: model.goBack)
            button(.arrowRight, "Forward (⌘])", enabled: model.navHistory.canGoForward, action: model.goForward)
        }
        .offset(x: PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding
                + (sidebarHidden ? PaneToggle.size + 4 : 4),
                y: (Metrics.header - PaneToggle.size) / 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(alignment: .top) {
            // The row's real rectangle, read by the full-screen controls (never a fixed distance from the screen's top).
            ScreenViewReader { FullScreenLightsController.shared.register(row: $0, lights: nil) }
                .frame(height: Metrics.header).allowsHitTesting(false)
        }
        .overlay(alignment: .topLeading) {
            // Full screen: the window controls slide in from the left, into this row, ahead of the arrows (which the
            // clearance above has pushed right). Reduce Motion: they fade in place.
            if model.conversationFullScreen {
                FullScreenLightsView()
                    .offset(x: lightsX, y: FullScreenLights.lightY(rowHeight: Metrics.header))
                    .opacity(model.fullScreenLightsRevealed ? 1 : 0)
                    .allowsHitTesting(model.fullScreenLightsRevealed)
            }
        }
        .onAppear { model.recordLocation() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateBack)) { _ in model.goBack() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakNavigateForward)) { _ in model.goForward() }
    }

    private var lightsX: Double {
        FullScreenLights.groupX(revealed: Motion.reduceMotion || model.fullScreenLightsRevealed)
    }

    private func button(_ icon: LucideName, _ label: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(icon, size: 16, color: enabled ? Theme.muted : Theme.subtle.opacity(0.5))
                .frame(width: PaneToggle.size, height: PaneToggle.size).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).help(label).accessibilityLabel(label)
    }
}
