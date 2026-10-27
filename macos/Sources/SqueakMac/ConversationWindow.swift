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
            } else {
                NavigationSplitView(columnVisibility: $visibility) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 200, ideal: 216, max: 280)
                } content: {
                    ContentColumn()
                        .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 520)
                } detail: {
                    DetailView()
                }
                .searchable(text: $model.query, placement: .sidebar, prompt: "Search sessions…")
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
        .frame(minWidth: 960, minHeight: 600)
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
            Task { @MainActor in AppModel.shared.conversationWindow = w }
        }
    }
}

/// ⌘K focuses search (the system gives ⌘F), and the title leaves the toolbar: each column has its own heading.
private struct WindowStyling: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.modifier(SearchFocus()).toolbar(removing: .title)
        } else {
            content
        }
    }
}

@available(macOS 15, *)
private struct SearchFocus: ViewModifier {
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .searchFocused($focused)
            .background {
                Button("Search") { focused = true }
                    .keyboardShortcut("k", modifiers: .command)
                    .opacity(0).accessibilityHidden(true)
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
