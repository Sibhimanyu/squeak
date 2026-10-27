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
    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var model = model
        Group {
            if model.settingsSection != nil {
                SettingsShell()
            } else if (model.navFilter ?? .home) == .needsYou {
                // Needs you is a page, not a list beside a chat: two columns, the page as wide as the window.
                NavigationSplitView(columnVisibility: $visibility) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: Metrics.sidebarWidth, ideal: Metrics.sidebarWidth, max: Metrics.sidebarWidth)
                        .toolbar(removing: .sidebarToggle)
                } detail: {
                    NeedsYouPage().background(Theme.bg.ignoresSafeArea())
                }
                .modifier(WindowStyling())
            } else {
                NavigationSplitView(columnVisibility: $visibility) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: Metrics.sidebarWidth, ideal: Metrics.sidebarWidth, max: Metrics.sidebarWidth)
                        .toolbar(removing: .sidebarToggle)
                } content: {
                    ContentColumn()
                        .background(Theme.bg.ignoresSafeArea())
                        .navigationSplitViewColumnWidth(min: Metrics.listMinWidth, ideal: Metrics.listIdealWidth, max: Metrics.listMaxWidth)
                } detail: {
                    DetailView().background(Theme.bg.ignoresSafeArea())
                }
                .modifier(WindowStyling())
            }
        }
        .background(ConversationWindowReader())
        .background {
            // ⌘\ folds the filters column away and back, wherever focus is (search, list, composer).
            Button("Toggle Sidebar") { visibility = visibility == .all ? .doubleColumn : .all }
                .keyboardShortcut("\\", modifiers: .command)
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
