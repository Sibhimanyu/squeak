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
            Button("New chat…") {
                // With the menu-bar panel open, ⌘N starts the chat inside it.
                if MenuBarController.shared.isOpen { PopupNav.shared.openNewChat() } else { NewChatController.shared.show() }
            }
                .keyboardShortcut("n", modifiers: .command)
            Divider()
            // Both are always here with their real chord; ⌘T sits on whichever it triggers right now.
            Button(newItems.thread.title) { KeyRouter.shared.perform(.newThread) }
                .modifier(OptionalChord(chord: newItems.thread.chord))
            Button(newItems.terminal.title) { NewTerminalAction.perform(model) }
                .modifier(OptionalChord(chord: newItems.terminal.chord))
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
            Button(ShortcutFocus.closeTitle(in: focus.region, terminalOpen: focus.terminalOpen)) { CloseTabAction.perform() }
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
        CommandGroup(replacing: .sidebar) {
            Button("Toggle Sidebar") {
                NotificationCenter.default.post(name: .squeakToggleSidebar, object: nil)
            }
            .keyboardShortcut("b", modifiers: .command)
        }
        // Keys and names come from the registry (`registryShortcut`), the list the hover hints and the sheet read.
        CommandGroup(after: .sidebar) {
            Button("Toggle Inspector") { NotificationCenter.default.post(name: .squeakToggleInspector, object: nil) }
                .registryShortcut(.toggleInspector)
            Button("Toggle Code View") { NotificationCenter.default.post(name: .squeakToggleCode, object: nil) }
                .registryShortcut(.toggleCode)
            // View › Enter Full Screen (⌃⌘F) is the system's own item for a window that is `.fullScreenPrimary`
            // (ActivationPolicyController.makeOrdinary); a second one here would answer the same chord twice.
            Button("Toggle Terminal") { NotificationCenter.default.post(name: .squeakToggleTerminal, object: nil) }
                .registryShortcut(.toggleTerminal)
        }
        // Window › Minimize (⌘M), Zoom and Bring All to Front are the system's own items, and macOS greys Minimize in
        // full screen; Close Window is added beside them because ⌘W closes the open tab first.
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
            Button("Next Tab") { NotificationCenter.default.post(name: .squeakStepTab, object: 1) }
                .registryShortcut(.nextTab)
            Button("Previous Tab") { NotificationCenter.default.post(name: .squeakStepTab, object: -1) }
                .registryShortcut(.previousTab)
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
        }
        CommandMenu("Sessions") {
            ForEach(0..<9, id: \.self) { i in
                let list = model.ordered.flattened
                Button(list.indices.contains(i) ? list[i].label : "Session \(i + 1)") { model.selectIndex(i) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                    .disabled(!list.indices.contains(i))
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, even from a bare `swift run` (the bundle also sets LSUIElement).
        NSApp.setActivationPolicy(.accessory)
        ActivationPolicyController.shared.start()
        let model = AppModel.shared
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
        }
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
            updating: intent.updating, hasAppWindows: NSApp.windows.contains(where: ActivationPolicyController.isAppWindow))
        UpdateLog.standard.write("quit: decision=\(decision == .quit ? "quit" : "closeWindows") explicit=\(intent.explicitQuit) system=\(isQuitEvent && QuitPolicy.isSystemQuitReason(reason)) updating=\(intent.updating) installPending=\(intent.installPending) userQuit=\(intent.userQuit)")
        switch decision {
        case .quit:
            // A quit the person chose (not Sparkle's own) must stay a quit: an update staged to install on it
            // installs, but never reopens the app or arms the relaunch watcher.
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
        // The terminal has the keys: ⌘W closes its tab, never a chat.
        if KeyFocus.shared.terminalFocused, KeyRouter.shared.perform(.closeTerminalTab) { return }
        let key = NSApp.keyWindow
        let mainKey = key != nil && key === NSApp.mainWindow && key?.attachedSheet == nil && key?.sheetParent == nil
            && !(key is NSPanel) && key?.canBecomeMain == true
        let box = Box()
        if mainKey { NotificationCenter.default.post(name: .squeakCloseTab, object: box) }
        if CloseRouting.route(mainWindowKey: mainKey, tabClosable: box.handled) == .window { key?.performClose(nil) }
    }
}

/// ⌘T's chord on a menu item only while that item is what ⌘T does.
struct OptionalChord: ViewModifier {
    let chord: String?
    func body(content: Content) -> some View {
        if chord != nil { content.keyboardShortcut("t", modifiers: .command) } else { content }
    }
}

/// File › New Terminal: shows the panel and adds a shell in the open chat's folder.
@MainActor enum NewTerminalAction {
    static func perform(_ model: AppModel) {
        guard let folder = TerminalWorkspace.availability(cwd: model.selectedSession?.cwd).folder else { return }
        UserDefaults.standard.set(true, forKey: "inspectorOpen")
        UserDefaults.standard.set(true, forKey: "terminalOpen")
        TerminalHost.shared.add(workspace: folder, folder: folder)
    }
}
