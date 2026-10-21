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
            Heresay.configure(key: "pk_SBtaP3xDs3fa2b9BRe62tEnq", url: URL(string: "https://heresay-sibhi-42b1.web.app")!)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent().environment(model)
        } label: {
            MenuBarLabel().environment(model)
        }
        .menuBarExtraStyle(.window)

        Window("Squeak", id: "conversation") {
            ConversationView().environment(model)
                .heresay()
                // Once per install, say where reports live; only on the main window, never over Welcome.
                .onAppear { if Self.reportsEnabled { Heresay.introduce() } }
        }
        .defaultSize(width: 1000, height: 680)
        .suppressedAtLaunch()
        .commands {
            SqueakCommands(model: model)
            HeresayCommands()
        }
    }
}

struct MenuBarLabel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Image(nsImage: MenuBarIcon.image(for: MenuBarIcon.State(model: model)))
        .accessibilityLabel(model.attentionCount > 0 ? "Squeak, \(model.attentionCount) need you" : "Squeak")
        .task {
            // The label is alive from launch, so it is where the window actions are captured.
            model.openConversationWindow = { openWindow(id: "conversation") }
        }
        // The awake countdown beside the duck, kept current from launch.
        .task { await model.pollAwake() }
    }
}

struct SqueakCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New chat…") { NewChatController.shared.show() }
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
            Button("Check for updates…") { model.updater.checkForUpdates() }
                .disabled(!model.updater.canCheck)
        }
        CommandMenu("Sessions") {
            ForEach(0..<9, id: \.self) { i in
                let list = model.ordered.flattened
                Button(list.indices.contains(i) ? list[i].label : "Session \(i + 1)") { model.selectIndex(i) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                    .disabled(!list.indices.contains(i))
            }
            Divider()
            Button("Quick message") { QuickComposerController.shared.show() }
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
        // With none, a reopen is usually a clicked notification's activation: show the composer
        // (a notification's explicit target retargets it, in whichever order the two arrive).
        // "Open Squeak" in the popover and menus still opens the conversation directly.
        let action = ReopenPolicy.action(hasOrdinaryWindow: NSApp.windows.contains(where: ActivationPolicyController.isAppWindow))
        if action == .showQuickComposer { QuickComposerController.shared.scheduleReopen() }
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
        switch decision {
        case .quit:
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
