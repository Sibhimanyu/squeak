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
    /// Where the Pond, Code and Terminal panels sit (DockLayout); the old inspector/terminal keys are read once, to migrate.
    private var dock: DockStore { DockStore.shared }
    @AppStorage("inspectorTab") private var inspectorTabRaw = InspectorTab.changes.rawValue
    /// Pane widths, remembered across launches (§8.10: sidebar 200–360, inspector 280–560). The inspector's 0 means
    /// "not dragged yet": it takes its share of the window (30%).
    @AppStorage("sidebarWidth") private var sidebarWidthSaved = PaneWidths.sidebarDefault
    @State private var windowWidth: Double = 1440
    @State private var columnHeight: Double = 800
    /// Zen mode (⇧⌘.): both side panes away; what was open comes back with the same key.
    @State private var zenRestore: ZenState?
    /// The layout before Zen folded the right and bottom zones.
    @State private var zenLayout: DockLayout?
    /// Captures start with the sidebar hidden; a press of the toggle clears it.
    @State private var captureHidden: Bool

    init(initiallySidebarCollapsed: Bool = false) {
        _captureHidden = State(initialValue: initiallySidebarCollapsed)
    }

    private var sidebarHidden: Bool { captureHidden || sidebarHiddenSaved }

    private struct ZenState { var sidebarHidden: Bool }

    private func toggleZen() {
        if let r = zenRestore {
            sidebarHiddenSaved = r.sidebarHidden
            if let saved = zenLayout { dock.update { $0 = saved } }
            zenRestore = nil
            zenLayout = nil
        } else {
            zenRestore = ZenState(sidebarHidden: sidebarHiddenSaved)
            zenLayout = dock.layout
            sidebarHiddenSaved = true
            dock.update { $0 = $0.zen() }
        }
    }

    private func paneTransition(_ edge: Edge) -> AnyTransition { Motion.slide(edge) }

    private func toggleSidebar() {
        captureHidden = false
        sidebarHiddenSaved = !sidebarHidden
    }

    /// What the right zone takes before it is dragged: its share of the room beside the sidebar.
    private func inspectorFallback(sidebarOpen: Bool) -> Double {
        PaneWidths.inspectorDefault(
            window: windowWidth,
            sidebar: sidebarOpen ? PaneWidths.clamp(sidebarWidthSaved, PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault) : 0)
    }

    private var inspectorWidthSaved: Binding<Double> {
        Binding(get: { dock.layout.right.size ?? 0 }, set: { v in dock.update { $0.setSize(v > 0 ? v : nil, for: .right) } })
    }

    private func sidebarWidth(open: Bool, inspectorOpen: Bool) -> Double {
        PaneWidths.effective(
            sidebarWidthSaved, range: PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault, window: windowWidth,
            otherPane: inspectorOpen
                ? PaneWidths.clamp(inspectorWidthSaved.wrappedValue, PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: open)) : 0)
    }

    private func inspectorWidth(sidebarOpen: Bool) -> Double {
        PaneWidths.effective(
            inspectorWidthSaved.wrappedValue, range: PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: sidebarOpen), window: windowWidth,
            otherPane: sidebarOpen ? PaneWidths.clamp(sidebarWidthSaved, PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault) : 0)
    }

    var body: some View {
        @Bindable var model = model
        @Bindable var git = model.git
        let layout = dock.layout
        let ducklingOpen = DucklingRef.open(model.openDuckling, whenSelected: model.selectedSession?.key) != nil
        let dockFiles = dock.files
        let dockTerminals = dock.activeTerminals
        let rightWanted = layout.isZoneVisible(.right, files: dockFiles, terminals: dockTerminals) && !layout.right.collapsed
        let showsInspector = rightWanted && model.settingsSection == nil && NewChatController.shared.page == nil
            && model.navFilter != .usage && model.selectedSession != nil && PondsModel.shared.route == nil
        let sidebarW = sidebarWidth(open: !sidebarHidden, inspectorOpen: showsInspector)
        let inspectorW = inspectorWidth(sidebarOpen: !sidebarHidden)
        let showingSettings = model.settingsSection != nil
        let showingCompose = !showingSettings && NewChatController.shared.page != nil
        let chatOpen = !showingSettings && !showingCompose && model.navFilter != .usage && model.selectedSession != nil
            && PondsModel.shared.route == nil
        HStack(spacing: 0) {
            // The sidebar slot stays put when Settings opens or closes: only what is inside it changes, crossfading in
            // place (no horizontal travel); the slot itself still slides when the sidebar is toggled.
            if showingSettings || !sidebarHidden {
                ZStack(alignment: .topLeading) {
                    if showingSettings {
                        SettingsSidebar().ignoresSafeArea(.container, edges: .top)
                            .transition(Motion.morph(entering: true))
                    } else {
                        WorkbenchSidebar(width: sidebarW)
                            .overlay(alignment: .trailing) {
                                PaneResizeHandle(
                                    edge: .trailing, width: $sidebarWidthSaved, range: PaneWidths.sidebarRange, fallback: PaneWidths.sidebarDefault,
                                    window: windowWidth, otherPane: showsInspector ? inspectorW : 0)
                            }
                            .transition(Motion.morph(entering: false))
                    }
                }
                .frame(width: showingSettings ? Metrics.workbenchSidebar : sidebarW)
                .frame(maxHeight: .infinity, alignment: .topLeading)
                .background(SidebarBackground(edge: false))
                .transition(paneTransition(.leading)).zIndex(1)
            }
            if showingSettings {
                SettingsDetail().squeakWindowCanvas().ignoresSafeArea(.container, edges: .top)
            } else {
                let placement = chatOpen ? DockBottomPlacement.of(layout, files: dockFiles, terminals: dockTerminals) : .none
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        WorkbenchCentre(
                            sidebarHidden: sidebarHidden, inspectorOpen: showsInspector && chatOpen,
                            gitInRightStrip: showsInspector && chatOpen && layout.right.selected == .code && !ducklingOpen,
                            toggleSidebar: toggleSidebar, showingCompose: showingCompose
                        )
                        .squeakWindowCanvas()
                        if placement == .underCentre { DockBottomZone(session: model.selectedSession, columnHeight: columnHeight) }
                    }
                    if showsInspector, chatOpen {
                        VStack(spacing: 0) {
                            DockRightColumn(session: model.selectedSession, width: inspectorW)
                            if placement == .underRight { DockBottomZone(session: model.selectedSession, columnHeight: columnHeight).frame(width: inspectorW)
                                    .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
                            }
                        }
                        .overlay(alignment: .leading) {
                            PaneResizeHandle(
                                edge: .leading, width: inspectorWidthSaved, range: PaneWidths.inspectorRange, fallback: inspectorFallback(sidebarOpen: !sidebarHidden),
                                window: windowWidth, otherPane: sidebarHidden ? 0 : sidebarW)
                        }
                        .transition(paneTransition(.trailing)).zIndex(1)
                    }
                }
                .background(GeometryReader { g in
                    Color.clear.onAppear { columnHeight = g.size.height }.onChange(of: g.size.height) { _, h in columnHeight = h }
                })
                // Thin strips at the edges that have no zone, while a panel is being dragged.
                .overlay(alignment: .trailing) {
                    if chatOpen, dock.dragging != nil, !showsInspector { DockEdgeStrip(zone: .right) }
                }
                .overlay(alignment: .bottom) {
                    if chatOpen, dock.dragging != nil, !layout.isZoneVisible(.bottom, files: dockFiles, terminals: dockTerminals) { DockEdgeStrip(zone: .bottom) }
                }
            }
        }
        // Panes slide at motion-standard (§7) and the toggles ride their edges; Reduce Motion crossfades, with no travel.
        .animation(Motion.standard, value: sidebarHidden)
        .animation(Motion.standard, value: showingSettings)
        // A duckling opens in the right zone: show it if it was folded away.
        .onChange(of: model.openDuckling) { _, ref in
            if ref != nil {
                dock.update { l in
                    if l.right.panels.isEmpty { l.show(.pond) } else { l.setCollapsed(false, for: .right) }
                }
            }
        }
        .animation(Motion.standard, value: showsInspector && chatOpen)
        .onChange(of: dock.isTerminalShowing, initial: true) { _, showing in
            if showing { TerminalHost.shared.focusPending = true }
            KeyFocus.shared.setTerminalOpen(showing)
        }
        .onAppear { DockDragMonitor.install() }
        .onDisappear { KeyFocus.shared.setTerminalOpen(false) }
        .clipped()
        .overlay {
            if !showingSettings {
                PaneToggleOverlay(
                    leftOpen: !sidebarHidden, rightOpen: showsInspector && chatOpen, showsRight: chatOpen, window: windowWidth, sidebarWidth: sidebarW,
                    inspectorWidth: inspectorW, toggleLeft: toggleSidebar, toggleRight: { dock.update { $0.toggleRight() } }
                )
                .animation(Motion.standard, value: sidebarHidden)
                .animation(Motion.standard, value: showsInspector && chatOpen)
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
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleInspector)) { _ in dock.update { $0.toggleRight() } }
        // ⌥⌘C shows the Code panel, or closes it when it is the one showing; a diff opened anywhere shows it too.
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleCode)) { _ in dock.update { $0.toggle(.code) } }
        .onReceive(NotificationCenter.default.publisher(for: .squeakShowCode)) { _ in dock.update { $0.show(.code) } }
        .onReceive(NotificationCenter.default.publisher(for: .squeakShowFiles)) { _ in
            inspectorTabRaw = InspectorTab.files.rawValue
            dock.update { $0.show(.code) }
        }
        // ⌘J shows the terminal wherever it is docked, or closes it when it is the one showing.
        .onReceive(NotificationCenter.default.publisher(for: .squeakToggleTerminal)) { _ in TerminalActions.toggle(model) }
        .background(ConversationWindowReader())
        .commandPalette()
        .background {
            // ⌘\ also toggles the sidebar; ⌘⌥B the inspector and ⌘⌥1/2/3 its tabs, wherever focus is.
            VStack {
                Button("Toggle Sidebar") { toggleSidebar() }
                    .keyboardShortcut("\\", modifiers: .command)
                ForEach(Array(InspectorTab.available(native: model.selectedSession?.source == .squeak).enumerated()), id: \.element) { i, t in
                    Button("Inspector: \(t.title)") { inspectorTabRaw = t.rawValue; dock.update { $0.show(.code) } }
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
                w.titlebarSeparatorStyle = .none
                w.styleMask.insert(.fullSizeContentView)
                Reader.clearTitlebarSurface(w)
                // A window that opens already in full screen starts the bar-less chrome at once.
                if w.styleMask.contains(.fullScreen) { Reader.setChrome(w, fullScreen: true) }
                // Opaque, warm near-black (§3.2): no material shows through.
                w.isOpaque = true
                w.backgroundColor = NSColor(name: nil) { a in
                    NSColor(hex: a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? Tokens.Dark.bg : Tokens.Light.bg)
                }
            }
            Task { @MainActor in
                AppModel.shared.conversationWindow = w
                if let w { Self.restoreFullScreenOnce(w) }
            }
            observeFullScreen(w)
            observeTitlebar(w)
        }

        private static var fullScreenRestored = false
        /// The first time the main window shows in a run, it goes back to full screen if it was in it when the app
        /// last went down (on its saved display: AppKit puts a new window on the active one).
        @MainActor static func restoreFullScreenOnce(_ w: NSWindow) {
            let env = ProcessInfo.processInfo.environment
            let saved = UserDefaults.standard.bool(forKey: LaunchWindowPolicy.fullScreenKey)
            guard LaunchWindowPolicy.restoresFullScreen(saved: saved, alreadyRestored: fullScreenRestored,
                                                        captureOrDemo: env["SQUEAK_MAC_CAPTURE"] != nil || env["SQUEAK_MAC_DEMO"] != nil) else { return }
            fullScreenRestored = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                if !w.styleMask.contains(.fullScreen) { w.toggleFullScreen(nil) }
            }
        }

        /// Windowed: the system buttons go to an absolute spot (`TitlebarAlignment.windowedButtonOrigin`): the close
        /// button's circle in full screen's column, all three on the top row's centre line. AppKit re-lays them out on
        /// resize, full-screen exit, key/appearance changes and sidebar changes, so every one of those (and each
        /// button's own frame change) looks again; setting an already-correct frame is skipped, so it cannot loop.
        static func alignLights(_ w: NSWindow) {
            guard !w.styleMask.contains(.fullScreen), let close = w.standardWindowButton(.closeButton),
                  let parent = close.superview else { return }
            let types: [NSWindow.ButtonType] = [.closeButton, .miniaturizeButton, .zoomButton]
            for (i, type) in types.enumerated() {
                guard let b = w.standardWindowButton(type), b.superview === parent else { continue }
                let o = TitlebarAlignment.windowedButtonOrigin(index: i, buttonWidth: Double(b.frame.width), buttonHeight: Double(b.frame.height),
                                                               windowHeight: Double(w.frame.height), rowHeight: Double(Metrics.header))
                // Window coordinates -> the buttons' superview, whatever its flipping or offset.
                let target = parent.convert(NSRect(x: o.x, y: o.y, width: b.frame.width, height: b.frame.height), from: nil).origin
                if abs(b.frame.origin.x - target.x) >= 0.25 || abs(b.frame.origin.y - target.y) >= 0.25 { b.setFrameOrigin(target) }
            }
        }

        /// The system titlebar (the top ~28 pt) paints its own background/material/scroll-edge pocket even when transparent,
        /// which showed as a band across the top row. Those views are hidden (never the container: the buttons live in it,
        /// and full screen fades it by alpha) so the row's own surface is the only one.
        static func clearTitlebarSurface(_ w: NSWindow) {
            w.titlebarSeparatorStyle = .none
            guard let close = w.standardWindowButton(.closeButton) else { return }
            var container: NSView? = close.superview
            while let c = container, !String(describing: type(of: c)).contains("NSTitlebarContainerView") { container = c.superview }
            guard let root = container else { return }
            func walk(_ v: NSView) {
                for sub in v.subviews {
                    if TitlebarSurface.paintsBackground(className: String(describing: type(of: sub))) { sub.isHidden = true } else { walk(sub) }
                }
            }
            walk(root)
        }

        private var titlebarTokens: [NSObjectProtocol] = []
        private func observeTitlebar(_ w: NSWindow?) {
            titlebarTokens.forEach(NotificationCenter.default.removeObserver)
            titlebarTokens = []
            guard let w else { return }
            let nc = NotificationCenter.default
            let again: @Sendable (Notification) -> Void = { _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { Reader.clearTitlebarSurface(w); Reader.alignLights(w) } }
            }
            let names: [Notification.Name] = [NSWindow.didResizeNotification, NSWindow.didEndLiveResizeNotification,
                NSWindow.didExitFullScreenNotification, NSWindow.didBecomeKeyNotification,
                NSWindow.didChangeScreenNotification, NSWindow.didMoveNotification]
            for n in names { titlebarTokens.append(nc.addObserver(forName: n, object: w, queue: .main, using: again)) }
            // Appearance changes and any relayout of the titlebar's own container.
            if let parent = w.standardWindowButton(.closeButton)?.superview {
                parent.postsFrameChangedNotifications = true
                titlebarTokens.append(nc.addObserver(forName: NSView.frameDidChangeNotification, object: parent, queue: .main, using: again))
            }
            // AppKit resets a button's frame when it lays the titlebar out: look again whenever one moves.
            for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
                guard let b = w.standardWindowButton(type) else { continue }
                b.postsFrameChangedNotifications = true
                titlebarTokens.append(nc.addObserver(forName: NSView.frameDidChangeNotification, object: b, queue: .main, using: again))
            }
            appearanceObs = w.observe(\.effectiveAppearance) { _, _ in again(Notification(name: .init("x"))) }
            DispatchQueue.main.async { MainActor.assumeIsolated { Reader.alignLights(w) } }
        }
        private var appearanceObs: NSKeyValueObservation?

        private var tokens: [NSObjectProtocol] = []

        /// Full screen has no bar: no toolbar and no presentation-option override, so AppKit reserves nothing at rest; its
        /// titlebar reveal is made to draw nothing (FullScreenLightsController) and Squeak's own controls slide into the
        /// sidebar's top row instead. Windowed keeps the system traffic lights.
        static func setChrome(_ w: NSWindow, fullScreen: Bool) {
            if fullScreen { FullScreenLightsController.shared.enter(w) } else { FullScreenLightsController.shared.exit(w) }
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
