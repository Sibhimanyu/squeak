import Heresay
import SqueakCore
import SqueakUI
import SwiftUI

/// The Squeak app: a window around SqueakRootView. `squeak://open?s=<id>`
/// links (from Telegram cards, via the web redirect) open that session.
@main
struct SqueakApp: App {
    /// Who is signed in and when the app sees trouble, told to Heresay. Not in the demo screenshots.
    @MainActor private static let connectSignals: Void = {
        guard !ProcessInfo.processInfo.arguments.contains(where: { $0.hasPrefix("-squeak-demo") }) else { return }
        HostSignals.onAccount = { email, name in
            guard let id = HeresayIdentity.id(userId: nil, email: email) else { Heresay.identify(); return }
            Heresay.identify(id: id, label: name, email: email)
        }
        HostSignals.onTrouble = { _ = Heresay.nudge() }
    }()

    @StateObject private var overlay = ReportOverlay.shared

    init() {
        // No corner button: reports open from Settings › Report a problem (owner's choice).
        Heresay.configure(key: "pk_ywg4d-und-rWBiNMlKdaVU0t", url: URL(string: "https://heresay-sibhi.web.app")!, nudge: .all, crashReports: .send)
        _ = Self.connectSignals
    }

    var body: some Scene {
        WindowGroup {
            // Tell people once where reports live, when they reach the session list (never over
            // pairing). The default wording points at a corner button this app doesn't have.
            SqueakRootView(
                onMainScreen: {
                    Heresay.introduce(
                        title: "Help make Squeak better",
                        message: "Open Settings and choose Report a problem any time to say what's broken, confusing or could be better. A person reads every report."
                    )
                },
                onScreen: { Heresay.setScreen($0) },
                onReport: { ReportOverlay.shared.present() },
                onReportProblem: { problem, place in
                    ReportOverlay.shared.present(type: .broken, text: place.map { "\($0): \(problem)" } ?? problem)
                },
                navigation: .standalone
            )
            .onOpenURL { SqueakRouter.shared.handle($0) }
            // The introduction and Help's sheet hang here, except while the report window holds it.
            .background { if !overlay.active { Color.clear.heresay() } }
        }
    }
}
