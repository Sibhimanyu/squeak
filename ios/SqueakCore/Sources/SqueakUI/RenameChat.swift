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

    func body(content: Content) -> some View {
        content
            .alert("Rename chat", isPresented: Binding(get: { model.renameTarget != nil }, set: { if !$0 { model.renameTarget = nil } })) {
                TextField("Name", text: $text)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    guard let target else { return }
                    Task { problem = await model.rename(target, to: text) }
                }
            } message: {
                Text("It is renamed in Conductor too.")
            }
            .onChange(of: model.renameTarget) { _, new in
                guard let new else { return }
                target = new
                text = Presentation.displayTitle(new)
            }
            .alert("Couldn't rename", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
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
            if session.conductorSessionId != nil, session.open != false {
                Button("Rename") { model.renameTarget = session }
            }
        }
    }
}
#endif
