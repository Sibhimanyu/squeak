import AppKit
import SqueakMacCore
import SwiftUI

@main
struct SqueakMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            PopoverView().environment(model)
        } label: {
            MenuBarLabel().environment(model)
        }
        .menuBarExtraStyle(.window)

        Window("Squeak", id: "conversation") {
            ConversationView().environment(model)
        }
        .defaultSize(width: 1000, height: 680)
        .commands { SqueakCommands(model: model) }

        Settings {
            SettingsView().environment(model)
        }
    }
}

struct MenuBarLabel: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Image(nsImage: MenuBarIcon.image(for: MenuBarIcon.State(model: model)))
        .accessibilityLabel(model.attentionCount > 0 ? "Squeak, \(model.attentionCount) need you" : "Squeak")
        .task {
            // The label is alive from launch, so it is where the window actions are captured.
            model.openConversationWindow = { openWindow(id: "conversation") }
            model.openSettingsWindow = { openSettings() }
        }
    }
}

struct SqueakCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandMenu("Sessions") {
            ForEach(0..<9, id: \.self) { i in
                let list = model.ordered.flattened
                Button(list.indices.contains(i) ? list[i].label : "Session \(i + 1)") { model.selectIndex(i) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: .command)
                    .disabled(!list.indices.contains(i))
            }
            Divider()
            Button("Quick Message") { QuickComposerController.shared.show() }
            Button("Open in Conductor") { model.openInHost() }
                .keyboardShortcut("o", modifiers: [.command, .shift])
                .disabled(model.openURL == nil)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // No Dock icon, even from a bare `swift run` (the bundle also sets LSUIElement).
        NSApp.setActivationPolicy(.accessory)
        if let sheet = ProcessInfo.processInfo.environment["SQUEAK_MAC_ICON_SHEET"] {
            MenuBarIconSheet.write(to: sheet, master: ProcessInfo.processInfo.environment["SQUEAK_MAC_ICON_MASTER"])
            exit(0)
        }
        let model = AppModel.shared
        model.start()
        if let prefix = ProcessInfo.processInfo.environment["SQUEAK_MAC_CAPTURE"] {
            Task { await CaptureRunner.run(prefix: prefix, model: model) }
        } else {
            OnboardingController.shared.showIfNeeded()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
}
