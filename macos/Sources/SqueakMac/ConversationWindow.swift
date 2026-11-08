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
    @AppStorage(WindowAppearancePreference.transparencyKey) private var glassTransparency = WindowAppearancePreference.defaultTransparency
    @AppStorage(WindowAppearancePreference.sidebarContrastKey) private var glassSidebarContrast = WindowAppearancePreference.defaultSidebarContrast
    @State private var visibility: NavigationSplitViewVisibility = .all
    /// The person's own choice, kept across launches. A narrow window collapses the rail on top of it, never into it.
    @AppStorage("sidebarCollapsed") private var sidebarCollapsedSaved = false
    @AppStorage("sessionListHidden") private var sessionListHiddenSaved = false
    @State private var windowWidth: CGFloat = 1200
    @State private var expandedByHand = false
    /// Captures start with the rail; a press of the toggle clears it.
    @State private var captureCollapsed: Bool

    init(initiallySidebarCollapsed: Bool = false) {
        _captureCollapsed = State(initialValue: initiallySidebarCollapsed)
    }

    private var chatOpen: Bool {
        model.settingsSection == nil && NewChatController.shared.page == nil && model.navFilter != .usage
            && (model.navFilter ?? .home) != .needsYou && model.selectedSession != nil
    }

    private var sidebarCollapsed: Bool {
        captureCollapsed || WindowLayoutRule.sidebarCollapsed(
            saved: sidebarCollapsedSaved, chatOpen: chatOpen, windowWidth: windowWidth, expandedByHand: expandedByHand)
    }

    /// What the sidebar's own toggles read and write: a press while the window collapsed it widens it by hand.
    private var sidebarBinding: Binding<Bool> {
        Binding(
            get: { sidebarCollapsed },
            set: { collapsed in
                captureCollapsed = false
                if collapsed {
                    expandedByHand = false
                    sidebarCollapsedSaved = true
                } else {
                    expandedByHand = sidebarCollapsedSaved == false
                    sidebarCollapsedSaved = false
                }
            }
        )
    }

    private func toggleSidebar() { sidebarBinding.wrappedValue = !sidebarCollapsed }

    var body: some View {
        @Bindable var model = model
        let showingSettings = model.settingsSection != nil
        let showingCompose = !showingSettings && NewChatController.shared.page != nil
        let showingNeedsYou = !showingSettings && (model.navFilter ?? .home) == .needsYou
        let listHidden = WindowLayoutRule.listHidden(saved: sessionListHiddenSaved, chatOpen: chatOpen)
        NavigationSplitView(columnVisibility: $visibility) {
            if showingSettings {
                SettingsSidebar(isCollapsed: sidebarBinding)
                    .toolbar(removing: .sidebarToggle)
            } else {
                SidebarView(isCollapsed: sidebarBinding)
                    .toolbar(removing: .sidebarToggle)
            }
        } content: {
            if showingSettings || showingNeedsYou || showingCompose || listHidden {
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
            } else if showingCompose {
                DesktopComposePage().squeakWindowCanvas()
            } else if showingNeedsYou {
                NeedsYouPage().squeakWindowCanvas()
            } else {
                DetailView().squeakWindowCanvas()
            }
        }
        .modifier(WindowStyling())
        .squeakWindowCanvas()
        .environment(\.glassWindowEnabled, glassWindowAppearance && !reduceTransparency)
        .environment(\.glassTransparency, glassTransparency)
        .environment(\.glassSidebarContrast, glassSidebarContrast)
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleSidebar)) { _ in toggleSidebar() }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
            // Crossing back over the line forgets a hand-widened rail, so the next narrow window collapses again.
            if width >= WindowLayoutRule.narrowWidth { expandedByHand = false }
            windowWidth = width
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { sessionListHiddenSaved.toggle() } label: {
                    Lucide(.list, size: Metrics.icon, color: sessionListHiddenSaved ? Theme.working : Theme.muted)
                }
                .keyboardShortcut("l", modifiers: [.command, .option])
                .disabled(!chatOpen)
                .help(sessionListHiddenSaved ? "Show the session list (⌘⌥L)" : "Hide the session list (⌘⌥L)")
                .accessibilityLabel(sessionListHiddenSaved ? "Show session list" : "Hide session list")
            }
        }
        .background(ConversationWindowReader())
        .background {
            // ⌘\ collapses the navigation sidebar to an icon rail, wherever focus is.
            VStack {
                Button("Toggle Sidebar") { toggleSidebar() }
                    .keyboardShortcut("\\", modifiers: .command)
                if showingSettings {
                    Button("Back to sessions") { model.closeSettings() }
                        .keyboardShortcut(.cancelAction)
                }
            }
            .opacity(0).accessibilityHidden(true)
        }
        .frame(minWidth: 900, minHeight: 600)
        .sheet(item: $model.permissionSheet) { kind in PermissionSheet(kind: kind) }
    }
}

/// A permission's explainer over the window, opened by a menu-bar tip. Ticks by itself once macOS says yes.
private struct PermissionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let kind: PermissionKind

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.m) {
            PermissionExplainer(kind: kind, handsReader: { await model.client.handsGrants() })
            Button("Done") { dismiss() }.buttonStyle(SecondaryButtonStyle())
        }
        .padding(Space.l)
        .frame(width: 420)
    }
}

extension Notification.Name {
    static let squeakToggleSidebar = Notification.Name("SqueakToggleSidebar")
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
