import Heresay
import SqueakUI
import SwiftUI

/// The Squeak app: a window around SqueakRootView. `squeak://open?s=<id>`
/// links (from Telegram cards, via the web redirect) open that session.
@main
struct SqueakApp: App {
    init() {
        Heresay.configure(key: "pk_ywg4d-und-rWBiNMlKdaVU0t", url: URL(string: "https://heresay-sibhi-42b1.web.app")!)
    }

    var body: some Scene {
        WindowGroup {
            // Tell people once where Report is, when they reach the session list (never over pairing).
            SqueakRootView(onMainScreen: { Heresay.introduce() })
                .onOpenURL { SqueakRouter.shared.handle($0) }
                .heresayReportButton()
        }
    }
}
