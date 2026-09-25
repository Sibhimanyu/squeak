import SqueakUI
import SwiftUI

/// The standalone Squeak app: a window around SqueakRootView. The same view
/// can live as a tab inside another app.
@main
struct SqueakApp: App {
    var body: some Scene {
        WindowGroup { SqueakRootView() }
    }
}
