import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    var isShowing: Bool { window?.isVisible ?? false }

    func showIfNeeded() {
        let model = AppModel.shared
        guard !model.onboardingDone, !model.captureMode else { return }
        show()
    }

    func show() {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 600),
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

    /// Step 0 is the welcome, the one place the person says yes to Squeak installing its background
    /// service; any other step is the setup checklist.
    init(step: Int = 0, finish: @escaping () -> Void) {
        _step = State(initialValue: step)
        self.finish = finish
    }

    var body: some View {
        VStack(spacing: 0) {
            if step == 0 {
                welcome.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                welcomeFooter
            } else {
                ScrollView { SetupChecklistView() }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                checklistFooter
            }
        }
        .padding(.horizontal, Space.xxl)
        .padding(.top, Space.xxl)
        .padding(.bottom, Space.xl)
        .frame(width: 520, height: 600)
        .background(Theme.bg)
    }

    private var welcomeFooter: some View {
        HStack {
            Button("Skip") { finish() }.buttonStyle(.plain).foregroundStyle(Theme.muted).accessibilityLabel("Skip setup")
            Spacer()
            Button("Set up Squeak") {
                model.setup.confirmInstallService()
                step = 1
            }
            .buttonStyle(PrimaryButtonStyle())
            .keyboardShortcut(.defaultAction)
        }
        .font(.system(size: 13))
    }

    private var checklistFooter: some View {
        let done = model.setupChecklist.isComplete
        return HStack {
            Spacer()
            if done {
                Button("Done") { finish() }.buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                Button("Finish later") { finish() }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.defaultAction)
            }
        }
        .padding(.top, Space.m)
        .font(.system(size: 13))
    }

    private var welcome: some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 72).padding(.top, Space.xxl).padding(.bottom, Space.s)
            Text("Welcome to Squeak").font(.system(size: 22, weight: .semibold)).foregroundStyle(Theme.ink)
            Text("Squeak lives in your menu bar. It shows your coding-agent sessions, tells you when one needs you, and lets you answer without switching apps.")
                .font(.system(size: 14)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text("Setup takes a minute. Squeak installs its own background service, then you pick the rest. Nothing needs the terminal.")
                .font(.system(size: 13)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true).padding(.top, Space.xs)
            Text("You can skip this and finish later in Settings › Setup.")
                .font(.system(size: 12)).foregroundStyle(Theme.subtle).padding(.top, Space.xs)
        }
    }
}
