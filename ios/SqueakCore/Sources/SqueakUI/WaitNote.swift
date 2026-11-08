#if os(iOS)
import SqueakCore
import SwiftUI

/// "Still waiting for your Mac…" with Cancel, once a command has waited on the Mac for `WaitHint.after` seconds.
/// Cancel stops waiting on this phone only; it does not say the command was undone. Plain footnote on a surface
/// card, no new style (DESIGN.md).
struct WaitNote: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        // Reading `waits` registers the dependency; the timeline wakes it when a wait crosses the threshold.
        let any = !model.waits.isEmpty
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if any, let wait = model.longWait(now: context.date) {
                HStack(spacing: 10) {
                    Text(WaitHint.line).font(.footnote).foregroundStyle(Theme.muted)
                    Spacer(minLength: 8)
                    Button("Stop waiting") { model.cancelWait(wait.id) }
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
                        .frame(minHeight: 44)
                        .accessibilityHint("Stops waiting here. Your Mac may still do it.")
                }
                .padding(.horizontal, 14)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                .padding(.horizontal, 16).padding(.bottom, 8)
                .accessibilityElement(children: .contain)
            }
        }
    }
}

extension View {
    /// Puts the long-wait note at the bottom of this screen.
    func stillWaitingNote() -> some View { overlay(alignment: .bottom) { WaitNote() } }
}
#endif
