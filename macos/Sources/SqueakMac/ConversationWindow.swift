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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The person's own choices, kept across launches. The inspector starts closed (§8.10).
    @AppStorage("sidebarCollapsed") private var sidebarHiddenSaved = false
    @AppStorage("inspectorOpen") private var inspectorOpen = false
    @AppStorage("terminalOpen") private var terminalOpen = false
    @AppStorage("inspectorCodeView") private var codeView = false
    @AppStorage("inspectorTab") private var inspectorTabRaw = InspectorTab.changes.rawValue
    /// Pane widths, remembered across launches (§8.10: sidebar 200–360, inspector 280–560). The inspector's 0 means
    /// "not dragged yet": it takes its share of the window (30%).
    @AppStorage("sidebarWidth") private var sidebarWidthSaved = PaneWidths.sidebarDefault
    @AppStorage("inspectorWidth") private var inspectorWidthSaved = 0.0
    @State private var windowWidth: Double = 1440
    /// Zen mode (⇧⌘.): both side panes away; what was open comes back with the same key.
    @State private var zenRestore: ZenState?
    /// Captures start with the sidebar hidden; a press of the toggle clears it.
    @State private var captureHidden: Bool

    init(initiallySidebarCollapsed: Bool = false) {
        _captureHidden = State(initialValue: initiallySidebarCollapsed)
    }

    private var sidebarHidden: Bool { captureHidden || sidebarHiddenSaved }

    private struct ZenState { var sidebarHidden: Bool; var inspectorOpen: Bool }

    private func toggleZen() {
        if let r = zenRestore {
            sidebarHiddenSaved = r.sidebarHidden
            inspectorOpen = r.inspectorOpen
            zenRestore = nil
        } else {
            zenRestore = ZenState(sidebarHidden: sidebarHiddenSaved, inspectorOpen: inspectorOpen)
            sidebarHiddenSaved = true
            inspectorOpen = false
        }
    }

    private func paneTransition(_ edge: Edge) -> AnyTransition { Motion.slide(edge) }

    private func toggleSidebar() {
        captureHidden = false
        sidebarHiddenSaved = !sidebarHidden
    }

    private var inspectorTab: Binding<InspectorTab> {
        Binding(get: { InspectorTab.restored(inspectorTabRaw) }, set: { inspectorTabRaw = $0.rawValue })
    }

    /// What the inspector takes before it is dragged: its share of the room beside the sidebar.
    private func inspectorFallback(sidebarOpen: Bool) -> Double {
        PaneWidths.inspectorDefault(
            window: windowWidth,
            sidebar: sidebarOpen ? PaneWidths.clamp(sidebarWidthSaved, PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault) : 0)
    }

    private func sidebarWidth(open: Bool, inspectorOpen: Bool) -> Double {
        PaneWidths.effective(
            sidebarWidthSaved, range: PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault, window: windowWidth,
            otherPane: inspectorOpen
                ? PaneWidths.clamp(inspectorWidthSaved, PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: open)) : 0)
    }

    private func inspectorWidth(sidebarOpen: Bool) -> Double {
        PaneWidths.effective(
            inspectorWidthSaved, range: PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: sidebarOpen), window: windowWidth,
            otherPane: sidebarOpen ? PaneWidths.clamp(sidebarWidthSaved, PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault) : 0)
    }

    var body: some View {
        @Bindable var model = model
        @Bindable var git = model.git
        let showsInspector = inspectorOpen && model.settingsSection == nil && NewChatController.shared.page == nil
            && model.navFilter != .usage && model.selectedSession != nil && PondsModel.shared.route == nil
        let sidebarW = sidebarWidth(open: !sidebarHidden, inspectorOpen: showsInspector)
        let inspectorW = inspectorWidth(sidebarOpen: !sidebarHidden)
        let showingSettings = model.settingsSection != nil
        let showingCompose = !showingSettings && NewChatController.shared.page != nil
        let chatOpen = !showingSettings && !showingCompose && model.navFilter != .usage && model.selectedSession != nil
            && PondsModel.shared.route == nil
        HStack(spacing: 0) {
            if showingSettings {
                SettingsSidebar().ignoresSafeArea(.container, edges: .top)
                SettingsDetail().squeakWindowCanvas().ignoresSafeArea(.container, edges: .top)
            } else {
                if !sidebarHidden {
                    WorkbenchSidebar(width: sidebarW)
                        .overlay(alignment: .trailing) {
                            PaneResizeHandle(
                                edge: .trailing, width: $sidebarWidthSaved, range: PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault,
                                window: windowWidth, otherPane: showsInspector ? inspectorW : 0)
                        }
                        .transition(paneTransition(.leading)).zIndex(1)
                }
                WorkbenchCentre(
                    sidebarHidden: sidebarHidden, inspectorOpen: $inspectorOpen, toggleSidebar: toggleSidebar,
                    showingCompose: showingCompose
                )
                .squeakWindowCanvas()
                if inspectorOpen, chatOpen {
                    WorkbenchInspector(session: model.selectedSession, tab: inspectorTab, codeView: $codeView, width: inspectorW)
                        .overlay(alignment: .leading) {
                            PaneResizeHandle(
                                edge: .leading, width: $inspectorWidthSaved, range: PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: !sidebarHidden),
                                window: windowWidth, otherPane: sidebarHidden ? 0 : sidebarW)
                        }
                        .transition(paneTransition(.trailing)).zIndex(1)
                }
            }
        }
        // Panes slide at motion-standard (§7) and the toggles ride their edges; Reduce Motion crossfades, with no travel.
        .animation(Motion.standard, value: sidebarHidden)
        .animation(Motion.standard, value: inspectorOpen && chatOpen)
        .clipped()
        .overlay {
            if !showingSettings {
                PaneToggleOverlay(
                    leftOpen: !sidebarHidden, rightOpen: inspectorOpen && chatOpen, showsRight: chatOpen, window: windowWidth, sidebarWidth: sidebarW,
                    inspectorWidth: inspectorW, toggleLeft: toggleSidebar, toggleRight: { inspectorOpen.toggle() }
                )
                .animation(Motion.standard, value: sidebarHidden)
                .animation(Motion.standard, value: inspectorOpen && chatOpen)
            }
        }
        .overlay(alignment: .topLeading) {
            WorkbenchNavigation(sidebarHidden: sidebarHidden)
                .opacity(showingSettings ? 0 : 1)
                .allowsHitTesting(!showingSettings)
                .accessibilityHidden(showingSettings)
        }
        // Extend the whole clipping/overlay coordinate space into the title bar. Extending only
        // the children let the parent clip their headers off in a normal (non-fullscreen) window.
        .ignoresSafeArea(.container, edges: .top)
        .background(GeometryReader { geo in
            Color.clear.onAppear {
                windowWidth = geo.size.width
                // A saved width below the sidebar's minimum (an older build, a hand edit) is brought back on load.
                sidebarWidthSaved = PaneWidths.clamp(sidebarWidthSaved, PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault)
            }.onChange(of: geo.size.width) { _, w in windowWidth = w }
        })
        .modifier(WindowStyling())
        .squeakWindowCanvas()
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleSidebar)) { _ in toggleSidebar() }
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleInspector)) { _ in inspectorOpen.toggle() }
        // ⌥⌘C flips the right panel between the Pond panel and the Code view (opening it when closed); a diff opened
        // anywhere switches to Code without opening a closed panel.
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleCode)) { _ in
            if !inspectorOpen { inspectorOpen = true; codeView = true } else { codeView.toggle() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .squeakShowCode)) { _ in codeView = true }
        // ⌘J: the terminal lives in the right panel's lower part, so with the panel closed it opens both.
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleTerminal)) { _ in
            if !inspectorOpen { inspectorOpen = true; terminalOpen = true } else { terminalOpen.toggle() }
        }
        .background(ConversationWindowReader())
        .commandPalette()
        .background {
            // ⌘\ also toggles the sidebar; ⌘⌥B the inspector and ⌘⌥1/2/3 its tabs, wherever focus is.
            VStack {
                Button("Toggle Sidebar") { toggleSidebar() }
                    .keyboardShortcut("\\", modifiers: .command)
                ForEach(Array(InspectorTab.available(native: model.selectedSession?.source == .squeak).enumerated()), id: \.element) { i, t in
                    Button("Inspector: \(t.title)") { inspectorOpen = true; codeView = true; inspectorTabRaw = t.rawValue }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: [.command, .option])
                }
                GitShortcuts()
                WorkbenchShortcuts()
                Button("Zen mode") { toggleZen() }.keyboardShortcut(".", modifiers: [.command, .shift])
                if showingSettings {
                    Button("Back to sessions") { model.closeSettings() }
                        .keyboardShortcut(.cancelAction)
                }
            }
            .opacity(0).accessibilityHidden(true)
        }
        .frame(minWidth: 960, minHeight: 620)
        .sheet(item: $model.permissionSheet) { kind in PermissionSheet(kind: kind) }
        .sheet(item: $git.mergeConfirm) { MergeConfirmSheet(confirm: $0) }
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

/// Supplies `window(_:willUseFullScreenPresentationOptions:)` without replacing SwiftUI's own window delegate: every other
/// delegate message is forwarded to it. (NSWindow.delegate is weak, so the proxy is kept alive on the window.)
private final class FullScreenPresentation: NSObject, NSWindowDelegate {
    private weak var inner: NSWindowDelegate?
    nonisolated(unsafe) private static var key: UInt8 = 0

    static func install(on w: NSWindow) {
        if w.delegate is FullScreenPresentation { return }
        let proxy = FullScreenPresentation()
        proxy.inner = w.delegate
        objc_setAssociatedObject(w, &key, proxy, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        w.delegate = proxy
    }

    func window(_ window: NSWindow, willUseFullScreenPresentationOptions proposed: NSApplication.PresentationOptions) -> NSApplication.PresentationOptions {
        FullScreenChrome.presentationOptions(proposed: proposed)
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner as AnyObject?)?.responds(to: aSelector) == true
    }
    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        (inner as AnyObject?)?.responds(to: aSelector) == true ? inner : super.forwardingTarget(for: aSelector)
    }
}

private enum FullScreenChrome {
    static func presentationOptions(proposed: NSApplication.PresentationOptions) -> NSApplication.PresentationOptions {
        proposed.union([.fullScreen, .autoHideToolbar, .autoHideMenuBar])
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
                ActivationPolicyController.makeOrdinary(w)
                // Seamless chrome: the columns' own backgrounds run to the top edge, under the traffic lights.
                w.titlebarAppearsTransparent = true
                w.titleVisibility = .hidden
                w.styleMask.insert(.fullSizeContentView)
                // Full screen only: an empty unified toolbar, so the revealed traffic lights sit inline (Safari's) instead of
                // in a bare grey strip. Never in windowed mode, where a unified toolbar would grow the titlebar and
                // move the lights; windowed stays the plain configuration. (A window that opens already in full screen.)
                Reader.setChrome(w, fullScreen: w.styleMask.contains(.fullScreen))
                // Opaque, warm near-black (§3.2): no material shows through.
                w.isOpaque = true
                w.backgroundColor = NSColor(name: nil) { a in
                    NSColor(hex: a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? Tokens.Dark.bg : Tokens.Light.bg)
                }
            }
            Task { @MainActor in AppModel.shared.conversationWindow = w }
            observeFullScreen(w)
        }

        private var tokens: [NSObjectProtocol] = []

        static func setChrome(_ w: NSWindow, fullScreen: Bool) {
            if fullScreen {
                if w.toolbar == nil {
                    let bar = NSToolbar(identifier: "SqueakConversationChrome")
                    bar.showsBaselineSeparator = false
                    w.toolbar = bar
                }
                w.toolbarStyle = .unified
                // Without this AppKit keeps the (empty, black) toolbar on screen at rest and reserves its height, so the
                // content no longer reaches the top. Auto-hidden, it and the menu bar slide in together over the content.
                FullScreenPresentation.install(on: w)
            } else {
                w.toolbar = nil
            }
        }

        /// Full screen hides the traffic lights: the sidebar's top bar and the pane toggles drop their clearance for
        /// them. The state is set when the transition starts, so the layout is right as the window grows, not after.
        private func observeFullScreen(_ w: NSWindow?) {
            tokens.forEach(NotificationCenter.default.removeObserver)
            tokens = []
            guard let w else { return }
            let nc = NotificationCenter.default
            for (name, value) in [(NSWindow.willEnterFullScreenNotification, true), (NSWindow.didExitFullScreenNotification, false)] {
                tokens.append(nc.addObserver(forName: name, object: w, queue: .main) { _ in
                    Task { @MainActor in
                        Reader.setChrome(w, fullScreen: value)
                        AppModel.shared.conversationFullScreen = value
                    }
                })
            }
            Task { @MainActor in AppModel.shared.conversationFullScreen = w.styleMask.contains(.fullScreen) }
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
