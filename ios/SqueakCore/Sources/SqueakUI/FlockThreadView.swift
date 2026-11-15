#if os(iOS)
import SqueakCore
import SwiftUI

/// A pond member's thread, opened from "From the flock": the rows the Mac reduces from the pond's events, and a composer
/// when the owner and the starter let this person message it. It runs on its starter's Mac, so approvals and Stop are
/// never here; a question is shown, and answered on a Mac.
struct FlockThreadView: View {
    @Environment(AppModel.self) private var model
    let pondId: String
    let thread: PondThreads.FlockThread
    @State private var draft = ""
    @State private var sending = false
    @State private var problem: String?

    private var doc: FlockThreadDoc? { model.flockDoc(thread.id) }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        header
                        if let doc {
                            if doc.entries.isEmpty {
                                Text("Nothing in this thread yet.").font(.footnote).foregroundStyle(Theme.muted)
                            }
                            ForEach(doc.entries) { entry in FlockRow(entry: entry).id(entry.id) }
                        } else if model.flockLoaded {
                            Text("Your Mac hasn't sent this thread yet. Open the app on your Mac, then pull to refresh.")
                                .font(.footnote).foregroundStyle(Theme.muted)
                        } else {
                            HStack(spacing: 8) { ProgressView(); Text("Loading the thread").font(.footnote).foregroundStyle(Theme.muted) }
                        }
                    }
                    .padding(16)
                }
                .onChange(of: doc?.entries.last?.id) { _, last in
                    if let last { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last, anchor: .bottom) } }
                }
            }
            composer
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(doc?.title ?? thread.title)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.openFlock(thread.id) }
        .onDisappear { model.openFlock(nil) }
        .foregroundStyle(Theme.ink)
    }

    private var header: some View {
        let who = [doc?.by ?? thread.by, doc?.poweredBy ?? thread.poweredBy, (doc?.locked ?? thread.locked) == true ? "Locked" : nil]
            .compactMap { $0 }.joined(separator: " \u{00B7} ")
        return Text(who).font(.footnote).foregroundStyle(Theme.muted)
    }

    @ViewBuilder private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reason = doc?.readOnlyReason {
                Text(reason).font(.footnote).foregroundStyle(Theme.muted)
            } else if doc != nil {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Message \(doc?.by ?? thread.by)'s thread", text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .padding(10)
                        .background(Theme.bg.opacity(0.6), in: RoundedRectangle(cornerRadius: 14))
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.muted.opacity(0.3)))
                    Button { send() } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }
                Text("Goes through the pond to its starter's Mac.").font(.caption).foregroundStyle(Theme.muted)
            }
            if let problem { Text(problem).font(.footnote).foregroundStyle(.red) }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true; problem = nil
        Task {
            let reason = await model.sendFlockMessage(pondId: pondId, threadId: thread.id, text: text)
            sending = false
            if let reason { problem = reason } else { draft = "" }
        }
    }
}

private struct FlockRow: View {
    let entry: FlockThreadDoc.Entry

    var body: some View {
        switch entry.role {
        case "user":
            VStack(alignment: .leading, spacing: 2) {
                if let by = entry.by { Text(by).font(.caption).foregroundStyle(Theme.muted) }
                Text(entry.text).padding(10).background(Theme.muted.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
            }
        case "agent":
            Text(entry.text)
        case "thinking":
            Text(entry.text).font(.footnote).italic().foregroundStyle(Theme.muted)
        case "tool":
            Label(entry.text, systemImage: entry.done == true ? "checkmark.circle" : "gearshape")
                .font(.footnote).foregroundStyle(Theme.muted)
        case "question":
            Label(entry.text, systemImage: "questionmark.bubble")
                .font(.callout).foregroundStyle(entry.done == true ? Theme.muted : Theme.ink)
        case "approval":
            Label(entry.done == true ? "Approval: \(entry.text)" : "Waiting for its starter to approve: \(entry.text)", systemImage: "lock")
                .font(.footnote).foregroundStyle(Theme.muted)
        default:
            Text(entry.text)
        }
    }
}
#endif
