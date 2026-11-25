import AppKit
import Heresay
import SqueakMacCore
import SwiftUI

@main
struct SqueakMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    /// In-app reports (Help › Report a Problem…). Not in capture or demo runs, which must stay offline.
    static let reportsEnabled: Bool = {
        let env = ProcessInfo.processInfo.environment
        return Bundle.main.bundleIdentifier != nil && env["SQUEAK_MAC_CAPTURE"] == nil && env["SQUEAK_MAC_DEMO"] == nil
    }()

    init() {
        if Self.reportsEnabled {
            Heresay.configure(key: "pk_SBtaP3xDs3fa2b9BRe62tEnq", url: URL(string: "https://heresay-sibhi.web.app")!, nudge: .all, crashReports: .send)
        }
    }

    var body: some Scene {
        Window("Squeak", id: "conversation") {
            ConversationView().environment(model)
                .reportAnchor("conversation")
                // Once per install, say where reports live; only on the main window, never over Welcome.
                .onAppear { if Self.reportsEnabled { Heresay.introduce() } }
        }
        .defaultSize(width: 1100, height: 720)
        .suppressedAtLaunch()
        .commands {
            SqueakCommands(model: model)
            ReportCommands()
        }
    }
}

struct SqueakCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        // Commands are alive from launch, so this is where the window action is captured.
        let _ = { model.openConversationWindow = { openWindow(id: "conversation") } }()
        let _ = KeyRouter.shared.install(model: model)
        let focus = KeyFocus.shared
        let newItems = ShortcutFocus.newMenu(in: focus.region, terminalOpen: focus.terminalOpen)
        CommandGroup(replacing: .newItem) {
            // ⌘N makes a pond (the sidebar's Create page); ⌘T makes a thread.
            Button("New pond…") {
                // With the menu-bar panel open, ⌘N still starts a chat inside it.
                if MenuBarController.shared.isOpen { PopupNav.shared.openNewChat() } else { model.openNewPond() }
            }
                .keyboardShortcut("n", modifiers: .command)
            Button("New chat…") {
                // With the menu-bar panel open, the chat starts inside it.
                if MenuBarController.shared.isOpen { PopupNav.shared.openNewChat() } else { NewChatController.shared.show() }
            }
            Divider()
            // ⌘T is always a chat tab; a terminal tab is ⌃⇧` (KeyRouter handles both while the terminal has the keys).
            Button(newItems.thread.title) { KeyRouter.shared.perform(.newThread) }
                .keyboardShortcut("t", modifiers: .command)
            Button(newItems.terminal.title) { NewTerminalAction.perform(model) }
                .keyboardShortcut("`", modifiers: [.control, .shift])
            Divider()
            Button(PondWords.openFolderAsPond) { ProjectActions.shared.open(model) }
            Button("Clone repository…") { ProjectActions.shared.clone(model) }
        }
        CommandGroup(replacing: .appTermination) {
            Button("Close Squeak Window") { QuitIntent.shared.closeWindows() }
                .keyboardShortcut("q", modifiers: .command)
            Button("Quit Squeak Completely") { QuitIntent.shared.quitCompletely() }
                .keyboardShortcut("q", modifiers: [.command, .option])
        }
        // File > Close: Cmd-W closes the open tab; with none to close (or a sheet/other window key) it closes the window.
        CommandGroup(replacing: .saveItem) {
            Button(model.pondWorkspace == nil ? ShortcutFocus.closeTitle(in: focus.region, terminalOpen: focus.terminalOpen) : "Close Tab") {
                CloseTabAction.perform()
            }
                .registryShortcut(.closeTab)
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.openSettings() }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(after: .appInfo) {
            Button("Check for updates…") { model.updater.checkForUpdates(reveal: true) }
                .disabled(!model.updater.canCheck && !model.updater.isBusy)
        }
        // Sidebar, Inspector and every panel now live in Window (Photoshop-style); View keeps the system's own items.
        CommandGroup(replacing: .sidebar) {}
        // Window › Minimize (⌘M), Zoom and Bring All to Front are the system's own items, and macOS greys Minimize in
        // full screen; Close Window is added beside them because ⌘W closes the open tab first.
        // Window lists every panel with a checkmark when open (choose to open or close), then the Workspace submenu.
        CommandGroup(before: .windowList) {
            WindowPanelMenuItems()
            Divider()
            Menu("Workspace") { DockWorkspaceMenuItems() }
            Divider()
        }
        CommandGroup(after: .windowArrangement) {
            Button("Close Window") { (NSApp.keyWindow ?? NSApp.mainWindow)?.performClose(nil) }
                .registryShortcut(.closeWindow)
        }
        CommandMenu("Ponds") {
            Button("Move Pond Up") { NotificationCenter.default.post(name: .squeakMovePond, object: -1) }
                .registryShortcut(.movePondUp)
            Button("Move Pond Down") { NotificationCenter.default.post(name: .squeakMovePond, object: 1) }
                .registryShortcut(.movePondDown)
        }
        CommandMenu("Chat") {
            Button("Next Tab") {
                if !model.stepPondTab(by: 1) { NotificationCenter.default.post(name: .squeakStepTab, object: 1) }
            }
                .registryShortcut(.nextTab)
            Button("Previous Tab") {
                if !model.stepPondTab(by: -1) { NotificationCenter.default.post(name: .squeakStepTab, object: -1) }
            }
                .registryShortcut(.previousTab)
            if model.pondWorkspace == nil {
                Button("Move Tab Left") { NotificationCenter.default.post(name: .squeakMoveTab, object: -1) }
                    .registryShortcut(.moveTabLeft)
                Button("Move Tab Right") { NotificationCenter.default.post(name: .squeakMoveTab, object: 1) }
                    .registryShortcut(.moveTabRight)
            }
            Divider()
            Button("View All Changes") { NotificationCenter.default.post(name: .squeakShowAllChanges, object: nil) }
                .registryShortcut(.diffView)
            Divider()
            Button("Model Picker") { NotificationCenter.default.post(name: .squeakModelPicker, object: nil) }
                .registryShortcut(.modelPicker)
            Button("Next Thinking Level") { NotificationCenter.default.post(name: .squeakNextEffort, object: nil) }
                .registryShortcut(.effortPicker)
            Button("Attach Images…") { NotificationCenter.default.post(name: .squeakAttach, object: nil) }
                .registryShortcut(.attach)
            // Ducks have no archive (Off duty and Delete Duck): the item shows only for an add-on thread.
            if let archiveTitle = model.archiveMenuTitle {
                Divider()
                Button(archiveTitle) { model.archiveSelectedThread() }
                    .registryShortcut(.archiveThread)
            }
        }
        CommandMenu("Sessions") {
            if let workspace = model.pondWorkspace, let strip = model.pondWorkspaceStrip {
                ForEach(0..<9, id: \.self) { i in
                    if let tab = strip.target(at: i) {
                        let title = strip.row.ducks.first(where: { tab == .duck($0.id) })?.name
                            ?? PondItemLabel(item: tab, workspace: workspace, model: model).title
                        Button(title) { model.selectPondTab(tab) }
                            .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                    }
                }
            } else {
                ForEach(0..<9, id: \.self) { i in
                    let list = model.ordered.flattened
                    Button(list.indices.contains(i) ? list[i].label : "Session \(i + 1)") { model.selectIndex(i) }
                        .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                        .disabled(!list.indices.contains(i))
                }
            }
            Divider()
            Button("Quick message") { NewChatController.shared.showQuickMessage() }
            Button("Open in \(model.openHostName ?? "app")") { model.openInHost() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(model.openURL == nil)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationWillFinishLaunching(_ notification: Notification) {
        // The delegate must exist before launch ends, or the response that launched us is dropped.
        Notifier.shared.configure()
    }

    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    /// SIGTERM becomes a normal quit, so `willTerminate` runs and Heresay records a clean exit (the default action
    /// kills the process outright and the next launch files a false "closed unexpectedly").
    private var termSource: DispatchSourceSignal?
    private func installSigtermHandler() {
        signal(SIGTERM, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        src.setEventHandler {
            QuitIntent.shared.signalQuit = true
            NSApp.terminate(nil)
        }
        src.resume()
        termSource = src
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installSigtermHandler()
        // No Dock icon, even from a bare `swift run` (the bundle also sets LSUIElement).
        NSApp.setActivationPolicy(.accessory)
        ActivationPolicyController.shared.start()
        let model = AppModel.shared
        DockStore.shared.workspaceOf = { key in
            AppModel.shared.allSessions.first { $0.key == key }.map(SidebarTreeBuilder.workspaceKey)
        }
        // Read before `model.start()`, whose update restore consumes the marker.
        let updateMarker = UpdateRestoreMarker.decode(UserDefaults.standard.data(forKey: UpdateRestoreMarker.defaultsKey))?
            .usable(currentVersion: AppModel.appVersion)
        model.start()
        MenuBarController.shared.start(model: model)
        FloatingDuckController.shared.start(model: model)
        let env = ProcessInfo.processInfo.environment
        if model.demoMode, let refinement = env["SQUEAK_MAC_REFINEMENT_DEMO"] {
            // Demo data only, left running for a person or a UI test. No onboarding and no ordinary window:
            // "menu" is the menu-bar status item alone; "context" also opens the composer on demo-6's reply.
            if refinement == "context" { RefinementDemo.showContext() }
        } else if model.demoMode, env["SQUEAK_MAC_QUICK_DEMO"] == "1" {
            // Demo data only (the model refuses every send): the real composer and panel, left
            // open so a person or a UI test can click its destination menu. No onboarding.
            QuickComposerController.shared.show(target: SessionKey(provider: "conductor", hostSessionId: env["SQUEAK_MAC_QUICK_DEMO_TARGET"] == "1" ? "demo-1" : "demo-3"))
        } else if let prefix = env["SQUEAK_MAC_CAPTURE"] {
            Task { await CaptureRunner.run(prefix: prefix, model: model) }
        } else {
            OnboardingController.shared.showIfNeeded()
            // Started by the person: open the main window too. At login (or while Welcome is up) stay in the menu bar.
            let opens = LaunchWindowPolicy.opensWindow(
                source: Self.launchSource(), captureOrDemo: model.captureMode || model.demoMode,
                welcomeShowing: OnboardingController.shared.isShowing, updateRelaunchWindow: updateMarker?.window)
            if opens { Task { await Self.openMainWindow(model) } }
        }
    }

    /// `SMAppService.mainApp` starts the app with an open-application event whose `keyAEPropData` is
    /// `keyAELaunchedAsLogInItem`; Finder, the Dock, Spotlight, `open` and a direct run carry no such property.
    static func launchSource() -> LaunchWindowPolicy.Source {
        let event = NSAppleEventManager.shared().currentAppleEvent
        let prop = event?.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue
        return prop == OSType(keyAELaunchedAsLogInItem) ? .loginItem : .user
    }

    /// The window action is wired by the menu-bar label a moment after launch.
    static func openMainWindow(_ model: AppModel) async {
        for _ in 0..<30 where model.openConversationWindow == nil { try? await Task.sleep(for: .milliseconds(100)) }
        model.showConversationWindow()
    }

    /// Full screen is remembered: set on entering, cleared on leaving (unless the app is quitting).
    static var terminating = false
    static func noteFullScreen(_ on: Bool) {
        let d = UserDefaults.standard
        d.set(LaunchWindowPolicy.savedFullScreen(current: on, leavingBecauseAppIsQuitting: terminating,
                previous: d.bool(forKey: LaunchWindowPolicy.fullScreenKey)), forKey: LaunchWindowPolicy.fullScreenKey)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows _: Bool) -> Bool {
        // AppKit counts the popover and hidden panels in `flag`, so look for a real window ourselves.
        // With none, a click on the app opens the conversation window, unless a notification's click
        // arrives within a moment and shows the composer for its chat instead (either order).
        // A reopen that is Squeak's own Launch Services open (taking the menu bar) is no click, and must not
        // bring back a window just closed.
        let action = ReopenPolicy.action(
            hasOrdinaryWindow: NSApp.windows.contains(where: ActivationPolicyController.isAppWindow),
            selfOpenAt: ActivationPolicyController.shared.selfOpenAt, now: Date())
        if action == .showConversation { QuickComposerController.shared.scheduleReopen() }
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let intent = QuitIntent.shared
        let event = NSAppleEventManager.shared().currentAppleEvent
        let isQuitEvent = event?.eventClass == AEEventClass(kCoreEventClass) && event?.eventID == AEEventID(kAEQuitApplication)
        let reason = event?.attributeDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue
            ?? event?.paramDescriptor(forKeyword: AEKeyword(kAEQuitReason))?.enumCodeValue
        let decision = QuitPolicy.decide(
            explicitQuit: intent.explicitQuit, systemQuit: isQuitEvent && QuitPolicy.isSystemQuitReason(reason),
            updating: intent.updating, hasAppWindows: NSApp.windows.contains(where: ActivationPolicyController.isAppWindow),
            signalQuit: intent.signalQuit)
        UpdateLog.standard.write("quit: decision=\(decision == .quit ? "quit" : "closeWindows") explicit=\(intent.explicitQuit) system=\(isQuitEvent && QuitPolicy.isSystemQuitReason(reason)) updating=\(intent.updating) installPending=\(intent.installPending) userQuit=\(intent.userQuit)")
        if decision == .quit { Self.terminating = true }
        switch decision {
        case .quit:
            // A quit the person chose (not Sparkle's own) must stay a quit: an update staged to install on it
            // installs, but never reopens the app or arms the relaunch watcher.
            AppModel.shared.flushDraftsForQuit()  // drafts are on disk before the process goes
            if !intent.updating { intent.userQuit = true }
            if QuitPolicy.shouldSaveRestore(decision: decision, updating: intent.updating, installPending: intent.installPending) {
                AppModel.shared.saveUpdateRestore(restartAttempt: intent.updating)
            }
            return .terminateNow
        case .closeWindows:
            intent.closeWindows()
            return .terminateCancel
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    /// Terminal shells end with the app (DESIGN.md §8.10): SIGHUP their process groups.
    func applicationWillTerminate(_ notification: Notification) { TerminalHost.shared.hangUpAll() }
}

/// Why the app is terminating, as far as code inside the app can say. `QuitPolicy` decides.
@MainActor
final class QuitIntent {
    static let shared = QuitIntent()
    /// Set by the popover's Quit row and "Quit Squeak Completely"; never reset, the app is going.
    var explicitQuit = false
    /// Set when the process received SIGTERM: a quit that must complete (see `QuitPolicy.decide`).
    var signalQuit = false
    /// Set by Sparkle just before it terminates the app to install an update.
    var updating = false
    /// Set when Sparkle has an update staged that installs on the next real quit.
    var installPending = false
    /// Set when the app is terminating because the person quit it. Sparkle may still install a staged update then,
    /// but nothing may bring the app back.
    var userQuit = false

    /// Sparkle is about to quit the app to install an update. The quit must succeed, and the app must come back:
    /// Sparkle's own relaunch sometimes does not, so a detached watcher reopens it (RelaunchWatchdog), unless the
    /// person chose to quit.
    func beginUpdateQuit() {
        updating = true
        let relaunch = QuitPolicy.shouldRelaunchAfterUpdate(explicitQuit: explicitQuit, userQuit: userQuit)
        UpdateLog.standard.write("quit: update quit begins, relaunch=\(relaunch)")
        if relaunch { RelaunchWatchdog.arm() }
    }

    /// The person pressed "Restart to update". That is a choice to restart, not to quit, so any earlier quit flags
    /// (a quit that never completed) are cleared: the app must come back, and the watchdog is armed for this
    /// attempt alone.
    func beginUserRestart() {
        explicitQuit = false
        userQuit = false
        beginUpdateQuit()
    }

    /// An update attempt ended without the app quitting (an error, a timeout, an aborted install). Put every flag
    /// back so a later quit behaves, and cancel the watchdog so it cannot reopen the app after one.
    func endUpdateAttempt() {
        UpdateLog.standard.write("quit: update attempt ended, flags reset (updating=\(updating) userQuit=\(userQuit) explicit=\(explicitQuit))")
        updating = false
        userQuit = false
        explicitQuit = false
        RelaunchWatchdog.disarm()
    }

    func quitCompletely() {
        explicitQuit = true
        NSApp.terminate(nil)
    }

    /// Close every app window; `ActivationPolicyController` then drops back to the menu bar only.
    func closeWindows() {
        ActivationPolicyController.shared.cancelPendingWindow()
        for w in NSApp.windows where ActivationPolicyController.isAppWindow(w) { w.performClose(nil) }
    }
}

extension Scene {
    /// macOS 15 and later would open the first window at launch; Squeak is a menu-bar app.
    func suppressedAtLaunch() -> some Scene {
        if #available(macOS 15, *) { return self.defaultLaunchBehavior(.suppressed) }
        return self
    }
}

/// Cmd-W: the main window's strip answers `.squeakCloseTab` through the box; unanswered, the key window closes.
@MainActor enum CloseTabAction {
    final class Box { var handled = false }
    static func perform() {
        let key = NSApp.keyWindow
        let mainKey = key != nil && key === NSApp.mainWindow && key?.attachedSheet == nil && key?.sheetParent == nil
            && !(key is NSPanel) && key?.canBecomeMain == true
        if mainKey, AppModel.shared.closeCurrentPondItem() { return }
        // In the classic layout, a focused terminal closes its shell tab.
        if KeyFocus.shared.terminalFocused, KeyRouter.shared.perform(.closeTerminalTab) { return }
        let box = Box()
        if mainKey { NotificationCenter.default.post(name: .squeakCloseTab, object: box) }
        if CloseRouting.route(mainWindowKey: mainKey, tabClosable: box.handled) == .window { key?.performClose(nil) }
    }
}

/// File › New Terminal, "+" on a terminal's strip, ⌃⇧`: a new shell in the open chat's folder, as a new tab in `zone`
/// (nil = the home zone: where the Terminal panel sits, else the bottom), selected.
@MainActor enum NewTerminalAction {
    static func perform(_ model: AppModel, in zone: DockZone? = nil) {
        // On a pond page the terminal belongs to the pond: its folder, in the pond inspector.
        if zone == nil, case .pondHome(let key) = model.baseLocation {
            guard let folder = PondsModel.pondTerminalFolder(key) else { return }
            open(folder: folder, in: .right)
            return
        }
        guard let folder = TerminalWorkspace.availability(cwd: model.selectedSession?.cwd).folder else { return }
        open(folder: folder, in: zone)
    }

    static func open(folder: String, in zone: DockZone? = nil) {
        let host = TerminalHost.shared
        host.add(workspace: folder, folder: folder)
        let live = host.registry.tabs(folder).map(\.id)
        guard let id = host.registry.selected(folder)?.id else { return }
        DockStore.shared.openTerminal(id, folder: folder, live: live, in: zone)
    }
}

@MainActor enum TerminalActions {
    /// A shell's tab closed: its process ends (the host asks first when something is running). A replacement the host
    /// starts for the last shell opens in the zone the old one was in.
    static func close(_ id: UUID, folder: String) {
        let host = TerminalHost.shared
        let dock = DockStore.shared
        let zone = dock.activeTerminals.zone(of: id)
        let before = Set(host.registry.tabs(folder).map(\.id))
        host.requestClose(workspace: folder, id)
        let live = host.registry.tabs(folder).map(\.id)
        guard !live.contains(id) else { return }
        dock.closeTerminal(id)
        if let fresh = live.first(where: { !before.contains($0) }) {
            dock.openTerminal(fresh, folder: folder, live: live, in: zone)
        } else {
            dock.syncTerminals(folder: folder, live: live)
        }
    }

    /// ⌘J: folds or unfolds the zone that holds the terminal; with no shell it opens one in the home zone.
    static func toggle(_ model: AppModel) {
        if let folder = TerminalWorkspace.availability(cwd: model.selectedSession?.cwd).folder {
            DockStore.shared.syncTerminals(folder: folder, live: TerminalHost.shared.registry.tabs(folder).map(\.id))
        }
        if DockStore.shared.toggleTerminalZone() { NewTerminalAction.perform(model) }
    }
}
