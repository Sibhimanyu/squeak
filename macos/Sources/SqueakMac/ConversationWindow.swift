import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// The Squeak window (DESIGN.md §8.10, the workbench): a sidebar of projects, workspaces and chats, the
// workspace's chat tabs with the chat, and an inspector that starts closed. The composer and the answer
// cards use Liquid Glass behind `#available` with material fallbacks (Glass.swift). Nothing here sends by itself: an answer card,
// the Send button and ⌘↩ are deliberate taps.

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(WindowAppearancePreference.key) private var glassWindowAppearance = true
    @AppStorage(WindowAppearancePreference.transparencyKey) private var glassTransparency = WindowAppearancePreference.defaultTransparency
    @AppStorage(WindowAppearancePreference.sidebarContrastKey) private var glassSidebarContrast = WindowAppearancePreference.defaultSidebarContrast
    /// The person's own choices, kept across launches. The inspector starts closed (§8.10).
    @AppStorage("sidebarCollapsed") private var sidebarHiddenSaved = false
    @AppStorage("inspectorOpen") private var inspectorOpen = false
    @AppStorage("inspectorTab") private var inspectorTabRaw = InspectorTab.changes.rawValue
    /// Captures start with the sidebar hidden; a press of the toggle clears it.
    @State private var captureHidden: Bool

    init(initiallySidebarCollapsed: Bool = false) {
        _captureHidden = State(initialValue: initiallySidebarCollapsed)
    }

    private var sidebarHidden: Bool { captureHidden || sidebarHiddenSaved }

    private func toggleSidebar() {
        captureHidden = false
        sidebarHiddenSaved = !sidebarHidden
    }

    private var inspectorTab: Binding<InspectorTab> {
        Binding(get: { InspectorTab(rawValue: inspectorTabRaw) ?? .changes }, set: { inspectorTabRaw = $0.rawValue })
    }

    var body: some View {
        @Bindable var model = model
        let showingSettings = model.settingsSection != nil
        let showingCompose = !showingSettings && NewChatController.shared.page != nil
        let chatOpen = !showingSettings && !showingCompose && model.navFilter != .usage && model.selectedSession != nil
        HStack(spacing: 0) {
            if showingSettings {
                SettingsSidebar(isCollapsed: .constant(false))
                SettingsDetail().squeakWindowCanvas()
            } else {
                if !sidebarHidden { WorkbenchSidebar().ignoresSafeArea(.container, edges: .top).transition(.move(edge: .leading)) }
                WorkbenchCentre(
                    sidebarHidden: sidebarHidden, inspectorOpen: $inspectorOpen, toggleSidebar: toggleSidebar,
                    showingCompose: showingCompose
                )
                .squeakWindowCanvas()
                .ignoresSafeArea(.container, edges: .top)
                if inspectorOpen, chatOpen {
                    WorkbenchInspector(session: model.selectedSession, tab: inspectorTab).ignoresSafeArea(.container, edges: .top).transition(.move(edge: .trailing))
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: sidebarHidden)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: inspectorOpen && chatOpen)
        .modifier(WindowStyling())
        .squeakWindowCanvas()
        .environment(\.glassWindowEnabled, glassWindowAppearance && !reduceTransparency)
        .environment(\.glassTransparency, glassTransparency)
        .environment(\.glassSidebarContrast, glassSidebarContrast)
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleSidebar)) { _ in toggleSidebar() }
        .background(ConversationWindowReader())
        .background {
            // ⌘\ also toggles the sidebar; ⌘⌥B the inspector and ⌘⌥1/2/3 its tabs, wherever focus is.
            VStack {
                Button("Toggle Sidebar") { toggleSidebar() }
                    .keyboardShortcut("\\", modifiers: .command)
                Button("Toggle Inspector") { inspectorOpen.toggle() }
                    .keyboardShortcut("b", modifiers: [.command, .option])
                ForEach(Array(InspectorTab.allCases.enumerated()), id: \.element) { i, t in
                    Button("Inspector: \(t.rawValue)") { inspectorOpen = true; inspectorTabRaw = t.rawValue }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: [.command, .option])
                }
                if showingSettings {
                    Button("Back to sessions") { model.closeSettings() }
                        .keyboardShortcut(.cancelAction)
                }
            }
            .opacity(0).accessibilityHidden(true)
        }
        .frame(minWidth: 960, minHeight: 620)
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
