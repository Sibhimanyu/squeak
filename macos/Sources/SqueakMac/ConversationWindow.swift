import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// The Squeak window: a native three-column NavigationSplitView. A source-list sidebar (filters),
// a session list, and the conversation. The system draws the sidebar material and, on macOS 26,
// the toolbar glass; the floating composer and the answer cards use Liquid Glass behind
// `#available` with material fallbacks (Glass.swift). Nothing here sends by itself: an answer card,
// the Send button and ⌘↩ are deliberate taps.

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @AppStorage(WindowAppearancePreference.key) private var glassWindowAppearance = true
    @State private var visibility: NavigationSplitViewVisibility = .all
    @State private var sidebarCollapsed = false

    var body: some View {
        @Bindable var model = model
        let showingSettings = model.settingsSection != nil
        let showingNeedsYou = !showingSettings && (model.navFilter ?? .home) == .needsYou
        NavigationSplitView(columnVisibility: $visibility) {
            if showingSettings {
                SettingsSidebar(isCollapsed: $sidebarCollapsed)
                    .navigationSplitViewColumnWidth(min: sidebarCollapsed ? 64 : 200, ideal: sidebarCollapsed ? 64 : 216, max: sidebarCollapsed ? 64 : 280)
                    .toolbar(removing: .sidebarToggle)
            } else {
                SidebarView(isCollapsed: $sidebarCollapsed)
                    .navigationSplitViewColumnWidth(min: sidebarCollapsed ? 64 : Metrics.sidebarWidth, ideal: sidebarCollapsed ? 64 : Metrics.sidebarWidth, max: sidebarCollapsed ? 64 : Metrics.sidebarWidth)
                    .toolbar(removing: .sidebarToggle)
            }
        } content: {
            if showingSettings || showingNeedsYou {
                // Keep one stable three-column window shell; these full-width pages do not use the list column.
                Color.clear
                    .frame(minWidth: 0, idealWidth: 0, maxWidth: 0, maxHeight: .infinity)
                    .navigationSplitViewColumnWidth(min: 0, ideal: 0, max: 0)
            } else {
                ContentColumn()
                    .squeakWindowCanvas()
                    .navigationSplitViewColumnWidth(min: Metrics.listMinWidth, ideal: Metrics.listIdealWidth, max: Metrics.listMaxWidth)
            }
        } detail: {
            if showingSettings {
                SettingsDetail()
            } else if showingNeedsYou {
                NeedsYouPage().squeakWindowCanvas()
            } else {
                DetailView().squeakWindowCanvas()
            }
        }
        .modifier(WindowStyling())
        .squeakWindowCanvas()
        .environment(\.glassWindowEnabled, glassWindowAppearance && !reduceTransparency)
        .background(ConversationWindowReader())
        .background {
            // ⌘\ collapses the navigation sidebar to an icon rail, wherever focus is.
            VStack {
                Button("Toggle Sidebar") { sidebarCollapsed.toggle() }
                    .keyboardShortcut("\\", modifiers: .command)
                if showingSettings {
                    Button("Back to sessions") { model.closeSettings() }
                        .keyboardShortcut(.cancelAction)
                }
            }
            .opacity(0).accessibilityHidden(true)
        }
        .frame(minWidth: 900, minHeight: 600)
    }
}

/// Tells the model which NSWindow hosts the conversation, so "on screen" means this window and
/// not Settings or any other ordinary window.
private struct ConversationWindowReader: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Reader() }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class Reader: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let w = window
            if let w {
                // Seamless chrome: the columns' own backgrounds run to the top edge, under the traffic lights.
                w.titlebarAppearsTransparent = true
                w.titleVisibility = .hidden
                w.styleMask.insert(.fullSizeContentView)
                // The sidebar and the main canvas use behind-window material; keep the native window
                // background clear so that the selected appearance can show through.
                w.isOpaque = false
                w.backgroundColor = .clear
            }
            Task { @MainActor in AppModel.shared.conversationWindow = w }
        }
    }
}

/// The title leaves the toolbar: each column has its own heading. (⌘K lives on the sidebar's search field.)
private struct WindowStyling: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.toolbar(removing: .title).toolbarBackground(.hidden, for: .windowToolbar)
        } else {
            content.toolbarBackground(.hidden, for: .windowToolbar)
        }
    }
}

/// The middle column: Home's project cards, the Needs you decisions, or the sessions grouped by status.
private struct ContentColumn: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        switch model.navFilter ?? .home {
        case .home: HomeView()
        case .needsYou: NeedsYouPage()
        default: SessionListView()
        }
    }
}
