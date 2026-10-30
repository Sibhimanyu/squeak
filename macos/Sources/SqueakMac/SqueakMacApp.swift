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
            Heresay.configure(key: "pk_SBtaP3xDs3fa2b9BRe62tEnq", url: URL(string: "https://heresay-sibhi.web.app")!)
        }
    }

    var body: some Scene {
        Window("Squeak", id: "conversation") {
            ConversationView().environment(model)
                .heresay()
                // Once per install, say where reports live; only on the main window, never over Welcome.
                .onAppear { if Self.reportsEnabled { Heresay.introduce() } }
        }
        .defaultSize(width: 1100, height: 720)
        .suppressedAtLaunch()
        .commands {
            SqueakCommands(model: model)
            HeresayCommands()
        }
    }
}

struct SqueakCommands: Commands {
    let model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        // Commands are alive from launch, so this is where the window action is captured.
        let _ = { model.openConversationWindow = { openWindow(id: "conversation") } }()
        CommandGroup(replacing: .newItem) {
            Button("New chat…") {
                // With the menu-bar panel open, ⌘N starts the chat inside it.
                if MenuBarController.shared.isOpen { PopupNav.shared.openNewChat() } else { NewChatController.shared.show() }
            }
                .keyboardShortcut("n", modifiers: .command)
        }
        CommandGroup(replacing: .appTermination) {
            Button("Close Squeak Window") { QuitIntent.shared.closeWindows() }
                .keyboardShortcut("q", modifiers: .command)
            Button("Quit Squeak Completely") { QuitIntent.shared.quitCompletely() }
                .keyboardShortcut("q", modifiers: [.command, .option])
        }
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { model.openSettings() }
                .keyboardShortcut(",", modifiers: .command)
        }
        CommandGroup(after: .appInfo) {
            Button("Check for updates…") { model.updater.checkForUpdates(presenting: true) }
                .disabled(!model.updater.canCheck && !model.updater.isBusy)
        }
        CommandGroup(replacing: .sidebar) {
            Button("Toggle Sidebar") {
                NotificationCenter.default.post(name: .squeakToggleSidebar, object: nil)
            }
            .keyboardShortcut("b", modifiers: .command)
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
            Button("Open in Conductor") { model.openInHost() }
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
        let action = ReopenPolicy.action(hasOrdinaryWindow: NSApp.windows.contains(where: ActivationPolicyController.isAppWindow))
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
