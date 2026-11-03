import AppKit
import Foundation
import Observation
import SqueakMacCore

/// Settings › Cloud: what the daemon says about Firebase and Catalyst, and the actions on them.
/// `available` is false until the daemon answers `/control/cloud`; a 404 (an older daemon) hides the tab.
@MainActor @Observable
final class CloudModel {
    private(set) var state: CloudState?
    private(set) var available = false
    private(set) var projects: [CloudProject] = []
    private(set) var loadingProjects = false
    var pickedProject: CloudProject?

    /// What is running now, so a button shows progress and cannot be pressed twice.
    private(set) var testing: Set<CloudProvider> = []
    private(set) var checking = false
    private(set) var deploying = false
    private(set) var renaming = false
    private(set) var selecting: CloudProvider?
    private(set) var choosingProject = false

    /// A fixed sentence per card, shown under its buttons.
    private(set) var notices: [CloudProvider: String] = [:]
    /// The last answer of a test run here (a failed one has no `lastTest` on the daemon).
    private(set) var testErrors: [CloudProvider: String] = [:]

    @ObservationIgnored private let client: DaemonClient
    @ObservationIgnored private let demo: Bool

    init(client: DaemonClient, demo: Bool) { self.client = client; self.demo = demo }

    func refresh() async {
        guard !demo else { return }
        do {
            if let s = try await client.cloudState() { state = s; available = true } else { state = nil; available = false }
        } catch {
            // The daemon being down or busy is not "older": keep what was shown.
        }
    }

    /// Re-reads while a Catalyst step is working (a deploy), then stops.
    func pollWhileBusy() async {
        while !Task.isCancelled, state?.catalystBusy == true || deploying {
            try? await Task.sleep(for: .seconds(2))
            await refresh()
        }
    }

    func loadProjects() async {
        loadingProjects = true
        defer { loadingProjects = false }
        projects = ((try? await client.catalystProjects()) ?? nil) ?? []
        if pickedProject == nil || !projects.contains(where: { $0.id == pickedProject?.id }) { pickedProject = projects.first }
    }

    func chooseProject() async {
        guard let p = pickedProject else { return }
        choosingProject = true
        defer { choosingProject = false }
        let a = await client.selectCatalystProject(id: p.id)
        notices[.catalyst] = a.ok ? nil : a.error
        await refresh()
    }

    func deploy() async {
        deploying = true
        notices[.catalyst] = nil
        let work = Task { await refresh(); await pollWhileBusy() }
        let a = await client.deployCatalyst()
        deploying = false
        work.cancel()
        if !a.ok { notices[.catalyst] = a.error }
        await refresh()
    }

    func check() async {
        checking = true
        defer { checking = false }
        let a = await client.checkCatalyst()
        notices[.catalyst] = a.ok ? nil : a.error
        await refresh()
    }

    func test(_ p: CloudProvider) async {
        testing.insert(p)
        defer { testing.remove(p) }
        let t = await client.testCloud(p)
        testErrors[p] = t.ok ? nil : (t.error ?? "The test failed.")
        notices[p] = nil
        await refresh()
    }

    func renameFirebase(_ name: String) async -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        renaming = true
        defer { renaming = false }
        let a = await client.renameFirebase(displayName: trimmed)
        notices[.firebase] = a.ok ? "Renamed." : a.error
        await refresh()
        return a.ok
    }

    func use(_ p: CloudProvider) async {
        selecting = p
        defer { selecting = nil }
        let a = await client.selectCloud(p)
        notices[p] = a.ok ? (a.moved ? "Paired devices are moving to \(p.title)." : "Now using \(p.title).") : a.error
        await refresh()
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
