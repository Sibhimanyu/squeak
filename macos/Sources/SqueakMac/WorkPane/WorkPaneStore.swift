import Foundation
import Observation
import SqueakMacCore

// DESIGN.md 8.12 (stage 2): the window's one work pane. `WorkPane` (SqueakMacCore) decides; this keeps it observable and
// saves what is meant to last (the pin, each Duck's last view and width). Open or closed is never saved.

@MainActor @Observable
final class WorkPaneStore {
    static let shared = WorkPaneStore()
    static let defaultsKey = "workPane.v1"

    private(set) var pane: WorkPane
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.pane = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(WorkPane.self, from: $0) } ?? WorkPane()
    }

    func switched(to duck: String) { change { $0.switched(to: duck) } }
    func open(_ view: WorkPaneView, duck: String) { change { $0.open(view, duck: duck) } }
    func toggle(_ view: WorkPaneView, duck: String) { change { $0.toggle(view, duck: duck) } }
    func close() { change { $0.close() } }
    func setPinned(_ on: Bool) { change { $0.setPinned(on) } }
    func setWidth(_ width: Double, duck: String) { change { $0.setWidth(width, duck: duck) } }

    private func change(_ edit: (inout WorkPane) -> Void) {
        let before = pane
        edit(&pane)
        guard pane != before else { return }
        guard pane.pinned != before.pinned || pane.memory != before.memory, let data = try? JSONEncoder().encode(pane) else { return }
        defaults.set(data, forKey: Self.defaultsKey)
    }
}
