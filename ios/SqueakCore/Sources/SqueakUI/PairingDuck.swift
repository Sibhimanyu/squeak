#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Approved: the duck celebrates for a moment, then the app opens.
struct PairingCelebrationView: View {
    @Environment(AppModel.self) private var model
    let mac: String

    var body: some View {
                VStack(spacing: 20) {
            Spacer()
            PairingDuck(mood: .celebrating)
            Text(SignInScreen.connectedTitle).font(.title2.bold())
            Text(SignInScreen.connected(mac: mac)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .foregroundStyle(Theme.ink)
        .accessibilityElement(children: .combine)
        .task {
            try? await Task.sleep(for: .seconds(SignInScreen.celebrationTime))
            model.endPairingCelebration()
        }
    }
}

/// The one duck on the screen, its sprite and motion following the mood (DESIGN.md 6.3, 7).
/// Under Reduce Motion the sprite swaps with a fade and nothing moves.
struct PairingDuck: View {
    let mood: PairingMood
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    private var sprite: String { mood == .idle ? "squeak-duck-full" : "duck-\(mood.rawValue)" }
    private var period: Double {
        switch mood {
        case .idle: return 3.4
        case .working: return 1.1
        case .celebrating: return 0.55
        case .needsYou: return 0.6
        }
    }

    private var bob: CGFloat {
        switch mood {
        case .idle: return on ? -3 : 3
        case .working: return on ? -3 : 1
        case .celebrating: return on ? -14 : 0
        case .needsYou: return 0
        }
    }

    var body: some View {
        Image(sprite, bundle: .module)
            .resizable().scaledToFit().frame(width: 128, height: 128)
            .offset(y: reduceMotion ? 0 : bob)
            .rotationEffect(.degrees(reduceMotion || mood != .needsYou ? 0 : (on ? 5 : -5)))
            .id(mood)
            .transition(.opacity)
            .animation(.easeOut(duration: 0.2), value: mood)
            .onAppear { start() }
            .accessibilityHidden(true)
            .frame(height: 136)
    }

    private func start() {
        guard !reduceMotion else { return }
        let curve: Animation = mood == .celebrating
            ? .spring(response: period / 2, dampingFraction: 0.5)
            : .easeInOut(duration: period / 2)
        withAnimation(curve.repeatForever(autoreverses: true)) { on = true }
    }
}
#endif
