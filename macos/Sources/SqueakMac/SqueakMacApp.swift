import SwiftUI
import SqueakMacCore

// Placeholder entry point so the package builds. The real UI replaces this.
@main
struct SqueakMacApp: App {
    var body: some Scene {
        MenuBarExtra("Squeak", systemImage: "bird") {
            Text("Squeak 2.0")
                .padding()
        }
        .menuBarExtraStyle(.window)
    }
}
