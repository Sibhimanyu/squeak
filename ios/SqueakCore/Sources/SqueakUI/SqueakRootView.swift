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
    private let onMainScreen: (() -> Void)?
    private let onScreen: ((String) -> Void)?
    private let onReport: (() -> Void)?

    /// `onMainScreen` runs when the session list appears (paired, past onboarding).
    /// `onScreen` names the screen in front ("Pairing", "Sessions", "Session"), for the host's
    /// feedback tool. `onReport` opens that tool; Settings shows "Report a problem" when it is set.
    public init(
        onMainScreen: (() -> Void)? = nil, onScreen: ((String) -> Void)? = nil, onReport: (() -> Void)? = nil
    ) {
        self.onMainScreen = onMainScreen
        self.onScreen = onScreen
        self.onReport = onReport
    }

    /// Squeak's duck as a tab-bar glyph (a template image, so the tab bar
    /// tints it), for an app that hosts this view as a tab. Generated from
    /// the duck artwork; never an SF Symbol, which draws a generic bird.
    public static var tabIcon: Image { Image("squeak-tab-duck", bundle: .module) }

    public var body: some View {
        RootView(onMainScreen: onMainScreen)
            .environment(model)
            .environment(\.squeakScreen, ScreenReporter(report: onScreen, openReport: onReport))
            .tint(Theme.done)
            .onAppear { visible = true; update() }
            .onDisappear { visible = false; update() }
            .onChange(of: scenePhase) { _, _ in update() }
    }

    private func update() {
        if visible && scenePhase == .active { model.resume() } else { model.pause() }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    var onMainScreen: (() -> Void)?

    var body: some View {
        switch model.phase {
        case .unpaired: PairView().onAppear { screen.report?("Pairing") }
        case let .awaitingApproval(code, mac): AwaitingApprovalView(code: code, mac: mac)
        case .paired: HomeView().onAppear { screen.report?("Sessions"); onMainScreen?() }
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
}
#endif
