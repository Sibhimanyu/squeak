#if os(iOS)
import SqueakCore
import SwiftUI

/// The gear: which Mac this phone is paired with, how it is doing, and unpairing.
struct SettingsView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.squeakScreen) private var screen
    @State private var confirmingUnpair = false

    private var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    LabeledContent("Name", value: model.snapshot?.mac ?? "Not seen yet")
                    TimelineView(.periodic(from: .now, by: 20)) { _ in
                        let state = Connection.read(snapshot: model.snapshot, problem: model.problem, demo: model.demo)
                        LabeledContent("Status") {
                            HStack(spacing: 7) { StatusDot(color: state.color); Text(state.text) }
                        }
                    }
                    if let snapshot = model.snapshot {
                        LabeledContent("Last update", value: Age.describe(snapshot.generatedAt) == "now" ? "Just now" : "\(Age.describe(snapshot.generatedAt)) ago")
                    }
                }
                Section {
                    Text("Replies are signed on this iPhone and checked by your Mac. Face ID is asked before anything is sent.")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                } header: { Text("Security") }
                if let openReport = screen.openReport {
                    Section {
                        Button("Report a problem") {
                            // Close Settings first: the report sheet can't stack on this one.
                            dismiss()
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { openReport() }
                        }
                        .frame(minHeight: 44)
                    } header: { Text("Feedback") } footer: {
                        Text("Tell us what's broken, confusing or could be better. A person reads every report.")
                    }
                }
                Section {
                    Button("Unpair this iPhone", role: .destructive) { confirmingUnpair = true }
                        .frame(minHeight: 44)
                } footer: {
                    if !version.isEmpty { Text("Squeak for iPhone \(version)") }
                }
            }
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .confirmationDialog("Unpair this iPhone?", isPresented: $confirmingUnpair, titleVisibility: .visible) {
                Button("Unpair", role: .destructive) { model.unpair(); dismiss() }
            } message: {
                Text("It will stop seeing and answering your agents until you pair again.")
            }
        }
        .foregroundStyle(Theme.ink)
    }
}
#endif
