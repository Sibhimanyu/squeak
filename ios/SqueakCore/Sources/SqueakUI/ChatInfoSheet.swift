#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// The chat's navigation title: the thread's name, then "pond › stream". When the pond is one the Mac sent,
/// a tap on it pushes that pond's dashboard.
struct ThreadTitle: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session

    private var pondName: String { session.pond?.name ?? Presentation.projectName(session) }
    private var pondId: String? { session.pond?.id.isEmpty == false ? session.pond?.id : nil }

    var body: some View {
        let stream = Presentation.workspaceName(session)
        let context = UsageFormat.contextIsLow(session.contextPercent) ? UsageFormat.context(session.contextPercent) : nil
        let place = stream.isEmpty ? pondName : "\(pondName) › \(stream)"
        let face = VStack(spacing: 1) {
            Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1).truncationMode(.tail)
            Group {
                if let context {
                    Text(place + " · ") + Text(context).foregroundColor(Theme.needsYou)
                } else {
                    Text(place)
                }
            }
            .font(.caption).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
        }
        .frame(maxWidth: 260)
        if let id = pondId, model.pondItem(id) != nil {
            NavigationLink(value: HomeRoute.pond(id)) { face }
                .buttonStyle(.press)
                .tapHaptic(.navigate)
                .accessibilityLabel(Presentation.displayTitle(session))
                .accessibilityValue(place)
                .accessibilityHint("Opens the pond")
        } else {
            face
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Presentation.displayTitle(session))
                .accessibilityValue(place)
                .accessibilityAddTraits(.isHeader)
        }
    }
}

/// The Info sheet: this thread, what it changed, its helpers and the other threads in its pond. Only what the
/// snapshot already carries.
struct ChatInfoSheet: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let close: () -> Void
    let showDiff: () -> Void
    let openHelper: (PhoneSnapshot.Session.BackgroundTask) -> Void
    let openThread: (String) -> Void

    private var others: [PhoneSnapshot.Session] {
        let id = session.pond?.id ?? Presentation.projectName(session)
        let all = model.pondItem(id)?.sessions ?? []
        return Array(Presentation.newestFirst(all.filter { $0.key != session.key }).prefix(8))
    }

    var body: some View {
        NavigationStack {
            List {
                Section("This thread") {
                    row("Agent", Presentation.agentName(session.agent))
                    if let name = session.model { row("Model", [name, session.effort, session.fast == true ? "Fast" : nil].compactMap { $0 }.joined(separator: " · ")) }
                    row("Status", Presentation.status(session).text.isEmpty ? "Idle" : Presentation.status(session).text)
                    let branch = Presentation.workspaceName(session)
                    if !branch.isEmpty { row("Branch", branch) }
                    if session.contextPercent != nil { row("Context", UsageFormat.context(session.contextPercent) ?? "") }
                }
                .listRowBackground(Theme.surface)
                if let git = session.git {
                    Section("Changes") {
                        row("Summary", git)
                        if session.can(.diff) {
                            Button { Haptics.play(.tap); showDiff() } label: {
                                HStack { Text("View diff"); Spacer(); Lucide(.chevronRight, size: 12, color: Theme.subtle) }
                                    .frame(minHeight: 44).contentShape(Rectangle())
                            }
                            .accessibilityHint("Shows the files and their changes")
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
                if !session.helpers.isEmpty {
                    Section("Helpers") {
                        BackgroundStrip(tasks: session.helpers, threadId: session.key, forceOpen: true, onOpen: openHelper)
                            .listRowInsets(EdgeInsets())
                    }
                    .listRowBackground(Color.clear)
                }
                if !others.isEmpty {
                    Section("Other threads in this pond") {
                        ForEach(others) { other in
                            Button { Haptics.play(.navigate); openThread(other.key) } label: {
                                SessionRow(session: other, inProject: true)
                            }
                            .tint(Theme.ink)
                        }
                    }
                    .listRowBackground(Theme.surface)
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg)
            .navigationTitle("Info")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title) { Text(value).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing) }
            .accessibilityElement(children: .combine)
    }
}
#endif
