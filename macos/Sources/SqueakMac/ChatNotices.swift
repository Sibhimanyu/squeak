import SwiftUI
import SqueakMacCore

/// A calm line above the composer with one or two text buttons: a very large chat, or a message that did not go through.
/// The host decides when it shows (`NativeChatNotice`); this only draws.
struct ChatNoticeBar: View {
    let text: String
    let actions: [(title: String, run: () -> Void)]

    var body: some View {
        HStack(spacing: 12) {
            Text(verbatim: text).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(2)
            Spacer(minLength: 8)
            ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                Button(action: action.run) {
                    Text(verbatim: action.title).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }
}

/// "Continue in a new thread": the summary the host's cheap model wrote, editable, then the new thread starts with it.
struct HandoffSheet: View {
    let draft: NativeHandoffDraft
    let onStart: (String) -> Void
    let onCancel: () -> Void
    @State private var text = ""
    @State private var seeded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: NativeChatNotice.continueTitle).font(Typo.title)
            Text(verbatim: draft.failed ? NativeChatNotice.draftFailed : NativeChatNotice.draftHelp)
                .font(Typo.meta).foregroundStyle(Theme.muted)
            TextEditor(text: $text)
                .font(Typo.body)
                .frame(minWidth: 460, minHeight: 220)
                .overlay(alignment: .center) { if draft.loading && text.isEmpty { ProgressView().controlSize(.small) } }
                .disabled(draft.loading && text.isEmpty)
            HStack {
                Spacer()
                Button("Cancel", action: onCancel).buttonStyle(SecondaryButtonStyle())
                Button(NativeChatNotice.draftSend) { onStart(text) }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(draft.loading || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .onChange(of: draft) { _, d in seed(d) }
        .onAppear { seed(draft) }
    }

    private func seed(_ d: NativeHandoffDraft) {
        guard !seeded, !d.loading else { return }
        seeded = true
        text = d.text
    }
}
