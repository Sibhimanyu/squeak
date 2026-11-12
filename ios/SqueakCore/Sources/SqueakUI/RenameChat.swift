#if os(iOS)
import SqueakCore
import SwiftUI

/// Renaming a chat from a row's menu or the chat's own header: one alert at the root of the app, driven by
/// `AppModel.renameTarget`. The new name goes to Conductor through the Mac and shows when the Mac's next
/// view carries it.
struct RenameAlert: ViewModifier {
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @State private var target: PhoneSnapshot.Session?
    @State private var problem: String?
    @State private var closing: PhoneSnapshot.Session?
    @State private var closeProblem: String?
    @State private var archiving: PhoneSnapshot.Session?
    @State private var archiveProblem: String?

    func body(content: Content) -> some View {
        content
            .onChange(of: model.closeTarget) { _, new in closing = new }
            .confirmationDialog("Close this chat in \(closing?.sourceLabel ?? "its app")?", isPresented: Binding(get: { closing != nil }, set: { if !$0 { closing = nil; model.closeTarget = nil } }), titleVisibility: .visible) {
                Button("Close in \(closing?.sourceLabel ?? "its app")", role: .destructive) { Haptics.play(.tap); 
                    guard let session = closing else { return }
                    closing = nil; model.closeTarget = nil
                    Task { closeProblem = await model.closeInConductor(session) }
                }
                Button("Hide on this iPhone only") { Haptics.play(.tap); 
                    if let session = closing { model.hideHere(session) }
                    closing = nil; model.closeTarget = nil
                }
                Button("Cancel", role: .cancel) { Haptics.play(.tap); }
            } message: {
                Text("Closing shuts its tab on your Mac; the chat and its history stay. Hiding only tidies this iPhone, and the chat returns when it has news.")
            }
            .onChange(of: model.archiveTarget) { _, new in archiving = new }
            .confirmationDialog("Archive this workspace?", isPresented: Binding(get: { archiving != nil }, set: { if !$0 { archiving = nil; model.archiveTarget = nil } }), titleVisibility: .visible) {
                Button("Archive workspace", role: .destructive) { Haptics.play(.tap); 
                    guard let session = archiving else { return }
                    archiving = nil; model.archiveTarget = nil
                    Task { archiveProblem = await model.archiveWorkspace(of: session) }
                }
                Button("Cancel", role: .cancel) { Haptics.play(.tap); }
            } message: {
                Text("The app stops its chats and removes the worktree from your Mac; the branch and its commits stay, and you can restore it there. Your Mac refuses while anything in it is uncommitted.")
            }
            .alert("Couldn't archive", isPresented: Binding(get: { archiveProblem != nil }, set: { if !$0 { archiveProblem = nil } })) {
                Button("OK", role: .cancel) { Haptics.play(.tap); }
            } message: {
                Text(archiveProblem ?? "")
            }
            .alert("Couldn't close", isPresented: Binding(get: { closeProblem != nil }, set: { if !$0 { closeProblem = nil } })) {
                Button("OK", role: .cancel) { Haptics.play(.tap); }
            } message: {
                Text(closeProblem ?? "")
            }
            .alert("Rename chat", isPresented: Binding(get: { model.renameTarget != nil }, set: { if !$0 { model.renameTarget = nil } })) {
                TextField("Name", text: $text)
                Button("Cancel", role: .cancel) { Haptics.play(.tap); }
                Button("Rename") { Haptics.play(.tap); 
                    guard let target else { return }
                    Task { problem = await model.rename(target, to: text) }
                }
            } message: {
                Text("It is renamed in the Mac app too.")
            }
            .onChange(of: model.renameTarget) { _, new in
                guard let new else { return }
                target = new
                text = Presentation.displayTitle(new)
            }
            .alert("Couldn't rename", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) { Haptics.play(.tap); }
            } message: {
                Text(problem ?? "")
            }
    }
}

extension View {
    func renameAlert() -> some View { modifier(RenameAlert()) }

    /// A long press on a chat's row offers Rename, for a chat Conductor holds open (the Mac can only rename those).
    func renameMenu(_ session: PhoneSnapshot.Session, model: AppModel) -> some View {
        contextMenu {
            if session.can(.rename), session.open != false {
                Button("Rename") { Haptics.play(.tap); model.renameTarget = session }
            }
            if session.can(.close), session.open != false, session.state != "working", !session.needsYou {
                Button("Close in \(session.sourceLabel ?? "its app")", systemImage: "xmark.circle", role: .destructive) { Haptics.play(.tap); model.closeTarget = session }
            }
            Button("Hide on this iPhone", systemImage: "eye.slash") { Haptics.play(.tap); model.hideHere(session) }
        }
    }
}
#endif
