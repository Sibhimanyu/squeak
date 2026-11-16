import SwiftUI
import UniformTypeIdentifiers
import SqueakMacCore

extension DragKind {
    /// The pasteboard type this kind travels under, so a target can check it before any drop.
    var utType: UTType { UTType(exportedAs: identifier) }
}

extension DragScope {
    static func types(for target: DragTarget) -> [UTType] { accepted(by: target).map(\.utType) }
}

/// A drag payload: the plain string (for the receiving side to decode) plus a marker type that names its kind,
/// kept inside this app.
func dragProvider(_ text: String, kind: DragKind) -> NSItemProvider {
    let p = NSItemProvider(object: text as NSString)
    p.registerDataRepresentation(forTypeIdentifier: kind.identifier, visibility: .ownProcess) { done in
        done(Data(text.utf8), nil)
        return nil
    }
    return p
}

/// Reads the string out of a drop, whatever its kind.
@MainActor func loadDragString(_ info: DropInfo, kinds: [DragKind], _ then: @escaping @MainActor (String) -> Void) -> Bool {
    for kind in kinds {
        guard let p = info.itemProviders(for: [kind.utType]).first else { continue }
        p.loadDataRepresentation(forTypeIdentifier: kind.identifier) { data, _ in
            guard let data, let text = String(data: data, encoding: .utf8) else { return }
            Task { @MainActor in then(text) }
        }
        return true
    }
    return false
}

/// Accepts only the kinds the target allows: `validateDrop` answers from the type alone, so nothing else highlights.
struct ScopedDropDelegate: DropDelegate {
    let target: DragTarget
    let targeted: (Bool) -> Void
    let perform: @MainActor (String) -> Bool

    private var types: [UTType] { DragScope.types(for: target) }
    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: types) }
    func dropEntered(info: DropInfo) { if validateDrop(info: info) { targeted(true) } }
    func dropExited(info: DropInfo) { targeted(false) }
    func dropUpdated(info: DropInfo) -> DropProposal? { validateDrop(info: info) ? DropProposal(operation: .move) : nil }
    func performDrop(info: DropInfo) -> Bool {
        targeted(false)
        return MainActor.assumeIsolated {
            loadDragString(info, kinds: DragScope.accepted(by: target)) { text in _ = perform(text) }
        }
    }
}

extension View {
    /// Drop target for tabs on a strip (or zone edge); `perform` gets the dragged string once it is read.
    func scopedDrop(_ target: DragTarget, isTargeted: @escaping (Bool) -> Void, perform: @escaping @MainActor (String) -> Bool) -> some View {
        onDrop(of: DragScope.types(for: target), delegate: ScopedDropDelegate(target: target, targeted: isTargeted, perform: perform))
    }
}
