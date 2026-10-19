import SqueakMacCore
import SwiftUI

struct LaunchOfferBanner: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.launchOfferPending {
            HStack(spacing: 8) {
                Text("Open Squeak when you log in?")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Button("Not now") { model.answerLaunchOffer(enable: false) }.buttonStyle(QuietButtonStyle())
                Button("Turn on") { model.answerLaunchOffer(enable: true) }.buttonStyle(PrimaryButtonStyle())
            }
            .padding(10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}

struct EmptyStateView: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: symbol).font(.system(size: 28)).foregroundStyle(Theme.subtle)
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(message).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(24)
        .frame(maxWidth: 320)
        .accessibilityElement(children: .combine)
    }
}

/// What the popover and quick composer say about a send. Self-contained so these two surfaces do not
/// depend on the conversation window's delivery wording.
struct SendFeedback {
    var text: String
    var symbol: String
    var color: Color
    var succeeded: Bool

    init?(_ result: SendResult) {
        switch result {
        case .accepted(let via):
            let word = via == "terminal" ? "Terminal" : via == "conductor" ? "Conductor" : via
            self = .init(text: "Delivered via \(word)", symbol: "checkmark", color: Theme.subtle, succeeded: true)
        case .uncertain:
            self = .init(text: "Not confirmed. Check Conductor before resending.", symbol: "exclamationmark.circle", color: Theme.muted, succeeded: false)
        case .refused(let r):
            self = .init(text: "Refused: \(r)", symbol: "xmark.circle", color: Theme.error, succeeded: false)
        case .notSent(let r):
            self = .init(text: "Not sent: \(r)", symbol: "exclamationmark.circle", color: Theme.error, succeeded: false)
        }
    }

    private init(text: String, symbol: String, color: Color, succeeded: Bool) {
        self.text = text; self.symbol = symbol; self.color = color; self.succeeded = succeeded
    }

    /// Nil when the send went through, so the card goes quiet again.
    var failureText: String? { succeeded ? nil : text }
}
