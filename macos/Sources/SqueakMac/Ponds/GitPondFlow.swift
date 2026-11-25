import SqueakMacCore
import SwiftUI

// "Make it a Git Pond": the one confirm and result, shared by the pond's more-menu, the next-steps card and the
// "Put this on GitHub?" line. Private first, public optional; the result or the problem comes back in an alert.

private struct GitPondFlow: ViewModifier {
    let key: String
    @Binding var ask: Bool
    @Binding var busy: Bool
    var done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var outcome: (title: String, message: String)?

    private var ponds: PondsModel { .shared }

    func body(content: Content) -> some View {
        content
            .confirmationDialog("Make \(ponds.name(key: key)) a Git Pond?", isPresented: $ask, titleVisibility: .visible) {
                if let native = ponds.native(key: key) {
                    Button("Private repository on GitHub") { make(native, isPublic: false) }
                    Button("Public repository on GitHub") { make(native, isPublic: true) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(verbatim: FolderPond.gitPondQuestion(isPublic: false) + " Choose public only if you want everyone to see it.")
            }
            .alert(outcome?.title ?? "", isPresented: Binding(get: { outcome != nil }, set: { if !$0 { outcome = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(verbatim: outcome?.message ?? "")
            }
            .onChange(of: ask) { _, now in
                if now, model.demoMode { ask = false; outcome = (FirstPondJourney.gitPondFailedTitle, "Demo data: nothing is changed.") }
            }
    }

    private func make(_ p: NativeProject, isPublic: Bool) {
        busy = true
        Task {
            defer { busy = false }
            do {
                let made = try await model.nativeHost.makeGitPond(projectId: p.id, isPublic: isPublic)
                outcome = (FirstPondJourney.gitPondDoneTitle, FolderPond.gitPondResult(url: made.url, note: made.note))
                await model.refreshNativeProjects()
                done()
            } catch let e as NativeHostError {
                outcome = (FirstPondJourney.gitPondFailedTitle, e.reason)
            } catch {
                outcome = (FirstPondJourney.gitPondFailedTitle, "Squeak couldn\u{2019}t make this pond a Git Pond.")
            }
        }
    }
}

extension View {
    /// Setting `ask` to true opens the confirm; `busy` is true while it runs; `done` runs after it worked.
    func gitPondFlow(key: String, ask: Binding<Bool>, busy: Binding<Bool>, done: @escaping () -> Void = {}) -> some View {
        modifier(GitPondFlow(key: key, ask: ask, busy: busy, done: done))
    }
}
