#if os(iOS)
import SqueakCore
import SwiftUI

/// Squeak's whole iPhone UI as one view: pairing, the session list, answers.
///
/// The Squeak app is nothing but a window around this, and another app can
/// host it as a tab. It owns its model and polls only while it is on screen
/// — the app being in the foreground *and* this view being visible — which is
/// also what tells the Mac to publish and poll faster.
public struct SqueakRootView: View {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var visible = false
    /// When the splash began (cold launch, or a return after a long absence); nil once it is gone.
    @State private var splashSince: Date? = Date()
    @State private var backgroundedAt: Date?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let onMainScreen: (() -> Void)?
    private let onScreen: ((String) -> Void)?
    private let onReport: (() -> Void)?
    private let navigation: Navigation

    /// How the paired app is laid out. `embedded`, the default, is one screen with no bar of its own,
    /// for an app that hosts this view as one of its tabs (a bar inside a bar is never wanted).
    /// `tabs` is Squeak's own app: Home, Sessions, Needs you and Settings along the bottom.
    public enum Navigation: Sendable { case embedded, tabs }

    /// `onMainScreen` runs when the session list appears (paired, past onboarding).
    /// `onScreen` names the screen in front ("Pairing", "Sessions", "Session"), for the host's
    /// feedback tool. `onReport` opens that tool; Settings shows "Report a problem" when it is set.
    public init(
        onMainScreen: (() -> Void)? = nil, onScreen: ((String) -> Void)? = nil, onReport: (() -> Void)? = nil,
        navigation: Navigation = .embedded
    ) {
        self.navigation = navigation
        self.onMainScreen = onMainScreen
        self.onScreen = onScreen
        self.onReport = onReport
    }

    /// Squeak's duck as a tab-bar glyph (a template image, so the tab bar
    /// tints it), for an app that hosts this view as a tab. Generated from
    /// the duck artwork; never an SF Symbol, which draws a generic bird.
    public static var tabIcon: Image { Image("squeak-tab-duck", bundle: .module) }

    public var body: some View {
        ZStack {
            RootView(onMainScreen: onMainScreen, tabs: navigation == .tabs)
            if splashSince != nil { SplashView().transition(.opacity).zIndex(1) }
        }
            .environment(model)
            .environment(\.squeakScreen, ScreenReporter(report: onScreen, openReport: onReport))
            .tint(Theme.done)
            .onAppear { visible = true; update() }
            .onDisappear { visible = false; update() }
            .onChange(of: scenePhase) { _, phase in update(); phaseChanged(phase) }
            .onChange(of: model.freshSnapshotAt) { _, _ in evaluateSplash() }
            .onChange(of: model.phase) { _, _ in evaluateSplash() }
            .task(id: splashSince) {
                guard let since = splashSince else { return }
                try? await Task.sleep(for: .seconds(max(0, Splash.cap - Date().timeIntervalSince(since))))
                evaluateSplash()
            }
    }

    private var splashSuppressed: Bool {
        model.demo || ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("-squeak-") }
    }

    /// Takes the splash down as soon as the Mac has answered or the cap has passed.
    private func evaluateSplash() {
        guard let since = splashSince else { return }
        let show = Splash.shows(
            paired: model.phase == .paired, suppressed: splashSuppressed,
            freshSince: model.freshSnapshotAt.map { $0 >= since }, elapsed: Date().timeIntervalSince(since))
        if !show { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { splashSince = nil } }
    }

    /// Back from a long absence the old view is stale again: the same splash, until the Mac answers.
    private func phaseChanged(_ phase: ScenePhase) {
        if phase == .background { backgroundedAt = Date() }
        if phase == .active, let left = backgroundedAt {
            backgroundedAt = nil
            if Splash.returnShows(away: Date().timeIntervalSince(left)), model.phase == .paired, !splashSuppressed {
                splashSince = Date()
            }
        }
    }

    private func update() {
        if visible && scenePhase == .active { model.resume() } else { model.pause() }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    var onMainScreen: (() -> Void)?
    var tabs = false

    var body: some View {
        switch model.phase {
        case .unpaired: PairView().onAppear { screen.report?("Pairing") }
        case let .awaitingApproval(code, mac): AwaitingApprovalView(code: code, mac: mac)
        case .paired:
            Group { if tabs { HomeTabs() } else { HomeView() } }
                .renameAlert()
                .onAppear { screen.report?("Sessions"); onMainScreen?() }
        }
    }
}
/// The duck on Theme.bg while the first view from the Mac loads. Still under Reduce Motion.
struct SplashView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        ZStack {
            Theme.bg.ignoresSafeArea()
            VStack(spacing: 16) {
                Image("squeak-duck-full", bundle: .module)
                    .resizable().scaledToFit().frame(width: 128, height: 128)
                    .scaleEffect(breathe ? 1.04 : 1)
                Text("Checking in with your Mac…").font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Squeak, connecting to your Mac")
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) { breathe = true }
        }
    }
}

/// Tells the host which screen is in front.
struct ScreenReporter: @unchecked Sendable {
    var report: ((String) -> Void)?
    var openReport: (() -> Void)?
}

extension EnvironmentValues {
    @Entry var squeakScreen = ScreenReporter()
    /// Set by the tab bar so Home's Mac strip can switch to the Settings tab; nil outside it (a sheet opens).
    @Entry var openSettingsTab: (() -> Void)? = nil
}
#endif
