import AppKit
import SqueakMacCore
import SwiftUI

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    func showIfNeeded() {
        let model = AppModel.shared
        guard !model.onboardingDone, !model.captureMode else { return }
        show()
    }

    func show() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
                styleMask: [.titled, .closable], backing: .buffered, defer: false
            )
            w.title = "Welcome to Squeak"
            w.isReleasedWhenClosed = false
            w.contentView = NSHostingView(rootView: OnboardingView(finish: { [weak self] in self?.finish() }).environment(AppModel.shared))
            w.center()
            window = w
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    private func finish() {
        AppModel.shared.onboardingDone = true
        window?.close()
    }
}

struct OnboardingView: View {
    var finish: () -> Void
    @Environment(AppModel.self) private var model
    @State private var step = 0

    private let conductorInstalled = FileManager.default.fileExists(atPath: "/Applications/Conductor.app")

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Group {
                switch step {
                case 0: welcome
                case 1: detect
                case 2: works
                default: done
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack {
                Button("Skip") { finish() }.buttonStyle(QuietButtonStyle()).accessibilityLabel("Skip setup")
                Spacer()
                if step > 0 && step < 3 { Button("Back") { step -= 1 }.buttonStyle(QuietButtonStyle()) }
                Button(step == 3 ? "Done" : "Continue") { if step == 3 { finish() } else { step += 1 } }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(width: 480, height: 420)
        .background(Theme.bg)
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 56, height: 56)
            Text("Squeak lives in your menu bar").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
            Text("It shows every coding-agent session on this Mac, tells you when one needs you, and lets you answer without switching apps.")
                .foregroundStyle(Theme.muted)
            Text("Setup is optional. You can skip it and everything still works. It just tells you honestly what is connected.")
                .font(.system(size: 12)).foregroundStyle(Theme.subtle)
        }
    }

    private var detect: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("What Squeak found").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
            check(conductorInstalled, "Conductor is installed", "Conductor isn't in /Applications. Squeak can still follow sessions it sees, but can't open chats in Conductor.")
            check(model.isConnected, "Squeak service is running", model.connectionHelp ?? "Looking for the service…")
            check(model.tokenPresent, "Access token found", "Needed to send replies. Start the Squeak service once to create it.")
            Button("Check again") { model.recheck() }.buttonStyle(QuietButtonStyle())
        }
    }

    private func check(_ ok: Bool, _ good: String, _ bad: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(ok ? Theme.working : Theme.duck)
            VStack(alignment: .leading, spacing: 2) {
                Text(good).font(.system(size: 13, weight: .medium)).foregroundStyle(ok ? Theme.ink : Theme.muted)
                if !ok { Text(bad).font(.system(size: 11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var works: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What works").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
            bullet("checkmark", "Read conversations and see what an agent is doing")
            bullet("checkmark", "Reply to Conductor chats, one message at a time")
            bullet("checkmark", "Quick message from anywhere with a shortcut you choose")
            bullet("minus", "Approvals and attachments aren't supported yet. Squeak says so and offers Open in Conductor.")
        }
    }

    private func bullet(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(Theme.subtle).frame(width: 14)
            Text(text).font(.system(size: 13)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("You're set").font(.system(size: 20, weight: .semibold)).foregroundStyle(Theme.ink)
            Text("Click the duck in the menu bar any time. Pick a quick-message shortcut and a login option in Settings.")
                .foregroundStyle(Theme.muted)
            if model.isConnected && Bundled.isApp && !LoginItem.isEnabled {
                Button("Open Squeak at login") { model.answerLaunchOffer(enable: true) }.buttonStyle(QuietButtonStyle())
            }
        }
    }
}
