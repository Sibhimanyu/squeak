import AppKit
import Observation
import SqueakMacCore

/// Install asks first only when it would lose something: terminal tabs running a command (shells live in this app and
/// end with it). Chats run in the session host and are unaffected. "Install when free" waits for the version offered
/// and installs through the same path Install uses; the choice is kept across a relaunch.
@MainActor @Observable
final class UpdateInstallController {
    static let shared = UpdateInstallController()

    private(set) var waitingFor: String? = UserDefaults.standard.string(forKey: UpdateInstallGate.waitingKey)
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var install: (() -> Void)?
    @ObservationIgnored private var offered: (() -> String?)?

    var isWaiting: Bool { waitingFor != nil }

    /// The press on Install or Restart. `offeredVersion` and `perform` are read when the wait ends, not now.
    func request(version: String, offeredVersion: @escaping () -> String?, perform: @escaping () -> Void) {
        install = perform
        offered = offeredVersion
        switch UpdateInstallGate.onPress(busyTerminals: TerminalHost.shared.busyTerminalCount()) {
        case .installNow: perform()
        case .ask(let n): resolve(ask(n), version: version)
        default: break
        }
    }

    /// Picks the wait back up after a relaunch.
    func resume(offeredVersion: @escaping () -> String?, perform: @escaping () -> Void) {
        guard waitingFor != nil else { return }
        install = perform
        offered = offeredVersion
        startPolling()
    }

    func cancel() { set(nil) }

    private func ask(_ n: Int) -> UpdateInstallGate.Choice {
        let alert = NSAlert()
        alert.messageText = UpdateInstallGate.question(busyTerminals: n)
        alert.addButton(withTitle: "Install when free")
        alert.addButton(withTitle: "Install now")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn: return .installWhenFree
        case .alertSecondButtonReturn: return .installNow
        default: return .cancel
        }
    }

    private func resolve(_ choice: UpdateInstallGate.Choice, version: String) {
        let r = UpdateInstallGate.apply(choice, version: version)
        set(r.waitingFor)
        if r.install { install?() }
    }

    private func set(_ version: String?) {
        waitingFor = version
        UserDefaults.standard.set(version, forKey: UpdateInstallGate.waitingKey)
        task?.cancel()
        task = nil
        if version != nil { startPolling() }
    }

    private func startPolling() {
        task?.cancel()
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard let self, !Task.isCancelled else { return }
                switch UpdateInstallGate.onPoll(busyTerminals: TerminalHost.shared.busyTerminalCount(), waitingFor: waitingFor, offered: offered?()) {
                case .installNow: let go = install; set(nil); go?(); return
                case .keepWaiting: continue
                default: set(nil); return
                }
            }
        }
    }
}
