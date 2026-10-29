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

    /// The Welcome screen, or, with `at`, straight into the walk-through on that screen (Settings › Setup).
    func show(at screen: WalkScreen? = nil) {
        if window == nil {
            let w = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 620, height: 720),
                styleMask: [.titled, .closable], backing: .buffered, defer: false
            )
            w.title = "Welcome to Squeak"
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        window?.title = screen == nil ? "Welcome to Squeak" : "Set up Squeak"
        window?.contentView = NSHostingView(
            rootView: OnboardingView(step: screen == nil ? 0 : 1, walkStart: screen, finish: { [weak self] in self?.finish() })
                .environment(AppModel.shared))
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
    @State private var walkStart: WalkScreen?

    /// Welcome, the guided setup, then a walkthrough using the person's real sessions.
    init(step: Int = 0, walkStart: WalkScreen? = nil, finish: @escaping () -> Void) {
        _step = State(initialValue: step)
        _walkStart = State(initialValue: walkStart)
        self.finish = finish
    }

    var body: some View {
        VStack(spacing: 0) {
            if step == 0 {
                ScrollView { welcome }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                welcomeFooter
            } else if step == 1 {
                SetupWalkthroughView(
                    start: walkStart ?? model.walkthrough.firstOpen.map { .step($0) } ?? .summary,
                    finish: { step = 2 }, later: finish)
            } else {
                ScrollView { FirstSessionView(backToSetup: { walkStart = .summary; step = 1 }) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                firstSessionFooter
            }
        }
        .padding(.horizontal, Space.xxl)
        .padding(.top, Space.xxl)
        .padding(.bottom, Space.xl)
        .frame(width: 620, height: 720)
        .background(Theme.bg)
    }

    private var welcomeFooter: some View {
        HStack {
            Button("Set up later") { finish() }.buttonStyle(.plain).foregroundStyle(Theme.muted).accessibilityLabel("Set up Squeak later")
            Spacer()
            Button("Set up Squeak") {
                model.setup.confirmInstallService()
                walkStart = nil
                step = 1
            }
            .buttonStyle(PrimaryButtonStyle())
            .keyboardShortcut(.defaultAction)
        }
        .font(.system(size: 13))
    }

    private var firstSessionFooter: some View {
        HStack {
            Button("Done for now", action: finish)
                .buttonStyle(.plain).foregroundStyle(Theme.muted)
            Spacer()
            Button("Open Squeak") {
                finish()
                model.showConversationWindow()
            }
            .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction)
        }
        .padding(.top, Space.m)
        .font(.system(size: 13))
    }

    private var welcome: some View {
        VStack(spacing: Space.l) {
            VStack(spacing: Space.s) {
                DuckMark(width: 68).padding(.top, Space.m).accessibilityHidden(true)
                Text("Your agents. In view.")
                    .font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink)
                Text("Know when your coding agents need you.\nAnswer without switching apps.")
                    .font(.system(size: 14)).foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
            }

            // A small, explicitly labelled preview teaches where the app lives before installation.
            VStack(spacing: 0) {
                HStack(spacing: Space.s) {
                    Text("In your menu bar").font(Typo.meta).foregroundStyle(Theme.muted)
                    Spacer()
                    Image(nsImage: MenuBarIcon.image(for: .normal))
                        .renderingMode(.template).foregroundStyle(Theme.ink)
                    Image(systemName: "wifi").foregroundStyle(Theme.muted)
                    Image(systemName: "battery.100").foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, Space.m).padding(.vertical, Space.s)
                .background(Theme.surfaceRaised)
                Rectangle().fill(Theme.line).frame(height: 1)
                HStack(spacing: Space.m) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 20)).foregroundStyle(Theme.muted)
                    VStack(alignment: .leading, spacing: Space.xs) {
                        Text("An agent needs your answer").font(Typo.label).foregroundStyle(Theme.ink)
                        Text("See the question. Send your reply. Keep going.")
                            .font(Typo.body).foregroundStyle(Theme.muted)
                    }
                    Spacer(minLength: 0)
                }
                .padding(Space.m)
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Preview: Squeak lives in your Mac's menu bar. Click the duck to see agents and answer their questions.")

            VStack(alignment: .leading, spacing: Space.s) {
                Text("A quick setup. No terminal needed.").font(Typo.label).foregroundStyle(Theme.ink)
                Text("One short screen per step: the service and agent hooks first, then Conductor, notifications, your phone and more. Skip anything you don’t want.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.bottom, Space.l)
    }
}
