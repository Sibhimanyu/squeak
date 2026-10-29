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
                contentRect: NSRect(x: 0, y: 0, width: 850, height: 640),
                styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
            )
            w.title = "Welcome to Squeak"
            w.minSize = NSSize(width: 720, height: 540)
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
        HStack(spacing: 0) {
            SetupBrandRail(step: step, screen: currentScreen, walk: model.walkthrough)
                .frame(width: 238)
            Rectangle().fill(Theme.line).frame(width: 1)
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
            .padding(.horizontal, 30)
            .padding(.top, 28)
            .padding(.bottom, 24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg)
        }
        .background(Theme.bg)
    }

    private var currentScreen: WalkScreen? {
        guard step == 1 else { return nil }
        return walkStart ?? model.walkthrough.firstOpen.map { .step($0) } ?? .summary
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
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your agents. In view.")
                    .font(.system(size: 28, weight: .semibold)).tracking(-0.7).foregroundStyle(Theme.ink)
                    .accessibilityAddTraits(.isHeader)
                Text("Know when your coding agents need you. Answer without switching apps.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            menuBarPreview
            VStack(alignment: .leading, spacing: 8) {
                Label("A quick setup. No terminal needed.", systemImage: "sparkle")
                    .font(Typo.label).foregroundStyle(Theme.ink)
                Text("One short screen per step: the service and agent hooks first, then Conductor, notifications, your phone and more. Skip anything you don’t want.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
    }

    private var menuBarPreview: some View {
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Text("IN YOUR MENU BAR").font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1).foregroundStyle(Theme.muted)
                Spacer()
                Image(nsImage: MenuBarIcon.image(for: .normal)).renderingMode(.template).foregroundStyle(Theme.ink)
                Image(systemName: "wifi").foregroundStyle(Theme.muted)
                Image(systemName: "battery.100").foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 16).padding(.vertical, 13)
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 14) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 19)).foregroundStyle(Theme.duck)
                    .frame(width: 36, height: 36)
                    .background(Theme.duck.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    Text("An agent needs your answer").font(Typo.label).foregroundStyle(Theme.ink)
                    Text("See the question. Send your reply. Keep going.")
                        .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(16)
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Preview: Squeak lives in your Mac's menu bar. Click the duck to see agents and answer their questions.")
    }
}

/// A persistent brand and progress anchor makes each setup screen feel like part of one guided experience.
private struct SetupBrandRail: View {
    let step: Int
    let screen: WalkScreen?
    let walk: SetupWalkthrough
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drift = false

    private var activeStep: WalkStep? {
        guard case let .step(value)? = screen else { return nil }
        return value
    }

    private var stepNumber: Int? {
        guard let activeStep else { return nil }
        return walk.index(activeStep) + 1
    }

    private var railTitle: String {
        if step == 0 { return "A clearer view of work in motion." }
        if step == 2 { return "Your first session is ready." }
        if let activeStep { return activeStep.title }
        return walk.isFinished ? "All set." : "Your setup, at a glance."
    }

    private var railDetail: String {
        if step == 0 { return "A small duck. A little more peace of mind." }
        if step == 2 { return "Bring your conversations together in one place." }
        if let activeStep { return activeStep.why }
        return "Connect the pieces once. Squeak keeps watch from your menu bar."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LogoLockup(height: 24)
            Spacer(minLength: 20)
            SetupOrbitArtwork(isMoving: !reduceMotion, drift: drift)
                .frame(maxWidth: .infinity)
                .frame(height: 204)
                .accessibilityHidden(true)
            Spacer(minLength: 20)
            if let stepNumber {
                Text("STEP \(String(format: "%02d", stepNumber))  /  \(String(format: "%02d", walk.total))")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.1).foregroundStyle(Theme.muted)
                    .padding(.bottom, 10)
            } else {
                Text(step == 0 ? "MEET SQUEAK" : "WELCOME ABOARD")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced)).tracking(1.1).foregroundStyle(Theme.muted)
                    .padding(.bottom, 10)
            }
            Text(railTitle)
                .font(.system(size: 23, weight: .semibold)).tracking(-0.5).foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text(railDetail)
                .font(Typo.body).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 8)
            Spacer(minLength: 16)
            if step == 1 {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(walk.steps.enumerated()), id: \.element.id) { index, item in
                        HStack(spacing: 8) {
                            Circle().fill(progressColor(item)).frame(width: item == activeStep ? 7 : 5, height: item == activeStep ? 7 : 5)
                            Text(item.title).font(.system(size: 11, weight: item == activeStep ? .semibold : .regular))
                                .foregroundStyle(item == activeStep ? Theme.ink : Theme.muted)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                            if walk.state(item) == .done { Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Theme.working) }
                        }
                        .accessibilityHidden(true)
                    }
                }
                .padding(.top, 12)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 24)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.sidebar)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 3.2).repeatForever(autoreverses: true)) { drift = true }
        }
    }

    private func progressColor(_ step: WalkStep) -> Color {
        if step == activeStep { return Theme.duck }
        switch walk.state(step) {
        case .done: return Theme.working
        case .skipped: return Theme.offline
        case .todo: return Theme.lineStrong
        }
    }
}

private struct SetupOrbitArtwork: View {
    let isMoving: Bool
    let drift: Bool

    var body: some View {
        ZStack {
            Circle().fill(Theme.duck.opacity(0.08)).frame(width: 154, height: 154)
            ForEach([122.0, 158.0], id: \.self) { size in
                Circle().stroke(Theme.lineStrong, lineWidth: 1).frame(width: size, height: size)
            }
            Circle().stroke(Theme.duck.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [3, 5]))
                .frame(width: 188, height: 188)
                .rotationEffect(.degrees(drift ? 14 : -14))
            DuckMark(width: 72)
                .offset(y: isMoving && drift ? -5 : 3)
                .rotationEffect(.degrees(isMoving && drift ? -2 : 2))
            Image(systemName: "sparkle")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(Theme.duck)
                .offset(x: 69, y: -44)
                .scaleEffect(isMoving && drift ? 1.12 : 0.86)
            Circle().fill(Theme.working).frame(width: 8, height: 8).offset(x: -78, y: 32)
            Circle().fill(Theme.duck).frame(width: 6, height: 6).offset(x: 61, y: 64)
        }
        .animation(isMoving ? .easeInOut(duration: 3.2).repeatForever(autoreverses: true) : nil, value: drift)
    }
}
