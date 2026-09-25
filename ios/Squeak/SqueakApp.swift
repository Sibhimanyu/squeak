import SwiftUI

@main
struct SqueakApp: App {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Theme.done)
                // Only look while on screen: that is also what tells the Mac to hurry.
                .onChange(of: scenePhase, initial: true) { _, phase in
                    if phase == .active { model.resume() } else { model.pause() }
                }
        }
    }
}

struct RootView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        switch model.phase {
        case .unpaired: PairView()
        case let .awaitingApproval(code, mac): AwaitingApprovalView(code: code, mac: mac)
        case .paired: HomeView()
        }
    }
}
