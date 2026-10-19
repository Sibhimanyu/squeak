import SqueakUI
import SwiftUI

/// The Squeak app: a window around SqueakRootView. `squeak://open?s=<id>`
/// links (from Telegram cards, via the web redirect) open that session.
@main
struct SqueakApp: App {
    var body: some Scene {
        WindowGroup {
            SqueakRootView()
                .onOpenURL { SqueakRouter.shared.handle($0) }
        }
    }
}
