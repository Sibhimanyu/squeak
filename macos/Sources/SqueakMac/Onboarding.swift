import AppKit
import SqueakIcons
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
        ActivationPolicyController.shared.willShowWindow()
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
    @State private var step: Int

    init(step: Int = 0, finish: @escaping () -> Void) {
        _step = State(initialValue: step)
        self.finish = finish
    }

    private let conductorInstalled = FileManager.default.fileExists(atPath: "/Applications/Conductor.app")

    var body: some View {
        VStack(spacing: 0) {
            Group {
                switch step {
                case 0: welcome
                case 1: detect
                case 2: works
                default: done
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            footer
        }
        .padding(.horizontal, Space.xxl)
        .padding(.top, Space.xxl)
        .padding(.bottom, Space.xl)
        .frame(width: 480, height: 420)
        .background(Theme.bg)
    }

    private var footer: some View {
        HStack {
            if step == 0 || step == 3 {
                Button("Skip") { finish() }.buttonStyle(.plain).foregroundStyle(Theme.muted)
                    .opacity(step == 3 ? 0 : 1).accessibilityLabel("Skip setup")
            } else {
                Button("Back") { step -= 1 }.buttonStyle(.plain).foregroundStyle(Theme.muted)
            }
            Spacer()
            HStack(spacing: 6) {
                ForEach(0..<4, id: \.self) { Circle().fill($0 == step ? Theme.ink : Theme.subtle.opacity(0.4)).frame(width: 6, height: 6) }
            }
            .accessibilityHidden(true)
            Spacer()
            Button(step == 3 ? "Finish" : "Continue") { if step == 3 { finish() } else { step += 1 } }
                .buttonStyle(PrimaryButtonStyle())
                .keyboardShortcut(.defaultAction)
        }
        .font(.system(size: 13))
    }

    private func heading(_ text: String) -> some View {
        Text(text).font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
    }

    private var welcome: some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 72).padding(.top, Space.l).padding(.bottom, Space.s)
            heading("Squeak lives in your menu bar")
            Text("It shows your coding-agent sessions, tells you when one needs you, and lets you answer without switching apps.")
                .font(.system(size: 14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Setup is optional. Skip it and everything still works.")
                .font(.system(size: 12)).foregroundStyle(Theme.subtle).padding(.top, Space.xs)
        }
    }

    private var detect: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            heading("What Squeak found").frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: Space.m) {
                check(conductorInstalled, "Conductor is installed", "Conductor isn't in /Applications. Squeak can still follow sessions it sees, but can't open chats in Conductor.")
                check(model.isConnected, "Squeak service is running", model.connectionHelp ?? "Looking for the service…")
                check(model.tokenPresent, "Access token found", "Needed to send replies. Start the Squeak service once to create it.")
            }
            .padding(.top, Space.s)
            Button("Check again") { model.recheck() }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.muted)
        }
    }

    private func check(_ ok: Bool, _ good: String, _ bad: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Circle().fill(ok ? Theme.working : Theme.subtle).frame(width: 8, height: 8).padding(.top, 5)
            VStack(alignment: .leading, spacing: 2) {
                Text(good).font(.system(size: 13, weight: .medium)).foregroundStyle(ok ? Theme.ink : Theme.muted)
                if !ok { Text(bad).font(.system(size: 12)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var works: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            heading("What works").frame(maxWidth: .infinity)
            VStack(alignment: .leading, spacing: Space.m) {
                bullet(.check, "Read conversations and see what an agent is doing")
                bullet(.check, "Reply to Conductor chats, one message at a time")
                bullet(.check, "Quick message from anywhere with a shortcut you choose")
                bullet(.minus, "Approvals and attachments aren't supported yet. Squeak says so and offers Open in Conductor.")
            }
            .padding(.top, Space.s)
        }
    }

    private func bullet(_ symbol: LucideName, _ text: String) -> some View {
        HStack(alignment: .top, spacing: Space.m) {
            Lucide(symbol, size: 16, color: Theme.subtle).padding(.top, 1)
            Text(text).font(.system(size: 13)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var done: some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 56).padding(.top, Space.xl).padding(.bottom, Space.s)
            heading("You're set up")
            Text("Click the duck in the menu bar any time. Pick a quick-message shortcut and a login option in Settings.")
                .font(.system(size: 14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if model.isConnected && Bundled.isApp && !LoginItem.isEnabled {
                Button("Open Squeak at login") { model.answerLaunchOffer(enable: true) }
                    .buttonStyle(.plain).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink).padding(.top, Space.s)
            }
        }
    }
}
