import SwiftUI
import UniformTypeIdentifiers
import SqueakMacCore

extension DragKind {
    /// The pasteboard type this kind travels under, so a target can check it before any drop.
    var utType: UTType { UTType(exportedAs: identifier) }
}

extension DragScope {
    /// The custom types of the kinds a target takes, then plain text: the payload is always also plain text with a
    /// known prefix, so a target still takes it when the custom type is not matched (undeclared, or lost in transit).
    static func types(for target: DragTarget) -> [UTType] { accepted(by: target).map(\.utType) + [.utf8PlainText, .plainText] }
}

/// A drag payload: the prefixed plain string (read by any destination) plus a data representation under the kind's
/// own type, declared in the app's Info.plist (`UTExportedTypeDeclarations`).
func dragProvider(_ text: String, kind: DragKind) -> NSItemProvider {
    let p = NSItemProvider(object: text as NSString)
    p.registerDataRepresentation(forTypeIdentifier: kind.identifier, visibility: .all) { done in
        done(Data(text.utf8), nil)
        return nil
    }
    return p
}

/// Reads the string out of a drop: the kind's own type first, else the plain-text half. Only a payload whose prefix
/// names a kind the target takes is passed on, so ordinary text dragged in is ignored.
@MainActor func loadDragString(_ info: DropInfo, target: DragTarget, _ then: @escaping @MainActor (String) -> Void) -> Bool {
    func deliver(_ text: String) {
        guard DragKind.accepted(text, on: target) != nil else { return }
        Task { @MainActor in then(text) }
    }
    for kind in DragScope.accepted(by: target) {
        guard let p = info.itemProviders(for: [kind.utType]).first else { continue }
        p.loadDataRepresentation(forTypeIdentifier: kind.identifier) { data, _ in
            if let data, let text = String(data: data, encoding: .utf8) { deliver(text) }
        }
        return true
    }
    for p in info.itemProviders(for: [.utf8PlainText, .plainText]) where p.canLoadObject(ofClass: String.self) {
        _ = p.loadObject(ofClass: String.self) { text, _ in if let text { deliver(text) } }
        return true
    }
    return false
}

/// Accepts only the kinds the target allows: `validateDrop` answers from the type alone, so nothing else highlights.
struct ScopedDropDelegate: DropDelegate {
    let target: DragTarget
    let targeted: (Bool) -> Void
    let perform: @MainActor (String) -> Bool
    /// Where the pointer is over the target, in its own coordinates: told on entry, on every move and at the drop.
    var moved: ((CGPoint) -> Void)?

    private var types: [UTType] { DragScope.types(for: target) }
    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: types) }
    func dropEntered(info: DropInfo) { if validateDrop(info: info) { moved?(info.location); targeted(true) } }
    func dropExited(info: DropInfo) { targeted(false) }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        guard validateDrop(info: info) else { return nil }
        moved?(info.location)
        return DropProposal(operation: .move)
    }
    func performDrop(info: DropInfo) -> Bool {
        moved?(info.location)
        targeted(false)
        return MainActor.assumeIsolated {
            loadDragString(info, target: target) { text in _ = perform(text) }
        }
    }
}

extension View {
    /// Drop target for tabs on a strip (or zone edge); `perform` gets the dragged string once it is read.
    func scopedDrop(_ target: DragTarget, isTargeted: @escaping (Bool) -> Void, moved: ((CGPoint) -> Void)? = nil,
                    perform: @escaping @MainActor (String) -> Bool) -> some View {
        onDrop(of: DragScope.types(for: target), delegate: ScopedDropDelegate(target: target, targeted: isTargeted, perform: perform, moved: moved))
    }
}
