#if os(iOS)
import SwiftUI

/// A toggle that flips at once. `apply` returns a problem sentence, or nil when the Mac took it.
struct PendingToggle: View {
    let title: String
    let on: Bool
    let apply: (Bool) async -> String?
    @State private var held = Held<Bool>()

    var body: some View {
        Toggle(title, isOn: Binding(get: { held.shown(on) }, set: { new in
            Haptics.play(.toggle)
            let token = held.hold(new)
            Task {
                let problem = await apply(new)
                Haptics.play(problem == nil ? .confirmed : .refused)
                if problem != nil { held.release(token) }
                // Success waits for the Mac's own view to show it; this only stops a stuck value if it never does.
                try? await Task.sleep(for: .seconds(4))
                held.release(token)
            }
        }))
        .tint(Theme.primaryFill)
        .onChange(of: on) { _, _ in held.caughtUp() }
    }
}
#endif
