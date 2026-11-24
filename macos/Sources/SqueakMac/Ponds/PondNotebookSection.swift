import SqueakMacCore
import SwiftUI

/// The Pond's shared Notebook, in Pond settings: the lessons every Duck reads when it takes a Task. One lesson a
/// line; Save replaces the list. Ducks add to it at the end of a Task, so Reload shows what they added.
struct PondNotebookSection: View {
    let project: NativeProject
    @Environment(AppModel.self) private var model
    @State private var draft: NotebookDraft?
    @State private var saving = false
    @State private var problem: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Notebook").font(Typo.heading).foregroundStyle(Theme.ink)
            Text("Lessons that last, shared by every Duck in this Pond. A Duck adds one when it finishes a Task; edit or remove any here. One lesson a line.")
                .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if let current = draft {
                TextEditor(text: Binding(get: { draft?.text ?? current.text }, set: { draft?.text = $0 }))
                    .font(Typo.code).foregroundStyle(Theme.ink).scrollContentBackground(.hidden)
                    .padding(6).frame(height: 160)
                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                    .accessibilityLabel("Pond Notebook")
                Text(verbatim: current.summary).font(Typo.meta)
                    .foregroundStyle(current.isOverCap ? Theme.negative : Theme.muted)
                HStack(spacing: Space.s) {
                    Button("Save") { save() }.buttonStyle(SecondaryButtonStyle()).disabled(!current.canSave || saving)
                    Button("Reload") { Task { await load() } }.buttonStyle(QuietButtonStyle()).disabled(saving)
                }
            } else {
                Text("Loading…").font(Typo.meta).foregroundStyle(Theme.muted)
            }
            if let problem { Text(verbatim: problem).font(Typo.meta).foregroundStyle(Theme.negative) }
        }
        .task { await load() }
    }

    private func load() async {
        guard !model.demoMode else { draft = NotebookDraft(NativeNotebook()); return }
        do {
            draft = NotebookDraft(try await model.nativeHost.notebook(projectId: project.id))
            problem = nil
        } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't read the Notebook" }
    }

    private func save() {
        guard let lessons = draft?.lessons, !model.demoMode else { return }
        saving = true
        Task {
            defer { saving = false }
            do {
                draft = NotebookDraft(try await model.nativeHost.saveNotebook(projectId: project.id, lessons: lessons))
                problem = nil
            } catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't save the Notebook" }
        }
    }
}
