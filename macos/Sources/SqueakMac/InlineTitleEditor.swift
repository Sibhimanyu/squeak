import AppKit
import SqueakMacCore
import SwiftUI

/// A thread's title edited where it is shown: the title's own font and place, all selected and focused, Return saves,
/// Esc or a click elsewhere cancels. A refusal is one small `negative` line floating under the field, so no row moves.
struct InlineTitleEditor: View {
    let session: HostSession
    var font: Font = Typo.body
    var color: Color = Theme.ink
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var seeded = false
    @State private var wasFocused = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Thread name", text: $text)
            .textFieldStyle(.plain).font(font).foregroundStyle(color).lineLimit(1)
            .focused($focused)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).stroke(model.renameProblem == nil ? Theme.lineStrong : Theme.negative, lineWidth: 1))
            .padding(.horizontal, -4)
            .overlay(alignment: .bottomLeading) {
                if let words = model.renameProblem {
                    Text(verbatim: words).font(Typo.meta).foregroundStyle(Theme.negative).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                        .frame(width: 240, alignment: .leading)
                        .offset(y: 26).allowsHitTesting(false)
                }
            }
            .zIndex(1)
            .onAppear {
                guard !seeded else { return }
                seeded = true
                text = model.workbenchTitle(session)
                focused = true
                DispatchQueue.main.async { (NSApp.keyWindow?.firstResponder as? NSTextView)?.selectAll(nil) }
            }
            .onChange(of: text) { _, _ in model.renameEdited() }
            .onChange(of: focused) { _, now in
                if now { wasFocused = true } else if wasFocused, model.isRenaming(session) { model.cancelRename() }
            }
            .onSubmit { model.commitRename(session, typed: text) }
            .onExitCommand { model.cancelRename() }
            .accessibilityLabel("Thread name")
    }
}

/// A row's Button, or while its title is being renamed a plain container with the same label, so the button cannot take
/// the field's clicks (and the focus change that would cancel the rename).
struct RowOrButton<Label: View>: View {
    let editing: Bool
    let action: () -> Void
    @ViewBuilder let label: () -> Label

    var body: some View {
        if editing { label() } else { Button(action: action, label: label) }
    }
}
