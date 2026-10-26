import Heresay
import SqueakUI
import SwiftUI

/// The Squeak app: a window around SqueakRootView. `squeak://open?s=<id>`
/// links (from Telegram cards, via the web redirect) open that session.
@main
struct SqueakApp: App {
    init() {
        // No corner button: reports open from Settings › Report a problem (owner's choice).
        Heresay.configure(key: "pk_ywg4d-und-rWBiNMlKdaVU0t", url: URL(string: "https://heresay-sibhi.web.app")!)
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
                onReport: { Heresay.present() }
            )
            .onOpenURL { SqueakRouter.shared.handle($0) }
            .heresay()
        }
    }
}
