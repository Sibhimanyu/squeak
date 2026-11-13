import Foundation
import SqueakMacCore

/// Extensions (Settings › Extensions; the daemon's add-ons are `/control/addons`). What is available and on is the daemon's word (`/control/addons`); this keeps the
/// session sources, the file watcher and the pages in step with it, live, with no restart.
extension AppModel {
    /// The registered add-ons that are on.
    var enabledApps: [any AppAddon] { AddonRegistry.shared.apps.filter { enabledAddons.contains($0.id) } }

    /// Providers of the chats the enabled add-ons' hosts own.
    var hostProviders: Set<String> { enabledApps.reduce(into: Set<String>()) { $0.formUnion($1.providers) } }

    /// "Conductor" for a chat an enabled add-on's host owns, else nil.
    func hostName(of key: SessionKey) -> String? { enabledApps.first { $0.providers.contains(key.provider) }?.hostName }

    /// The open chat's host app, for "Open in …"; nil when its host is not an add-on.
    var openHostName: String? { selected.flatMap(hostName(of:)) }

    /// The enabled add-ons' project artwork, read off the main thread.
    func projectIcons() async -> [String: Data] {
        let readers = enabledApps.compactMap(\.iconReader)
        guard !readers.isEmpty else { return [:] }
        return await Task.detached(priority: .utility) {
            readers.reduce(into: [String: Data]()) { $0.merge($1()) { a, _ in a } }
        }.value
    }

    /// Every extension, add-ons and built-in channels merged; what the Extensions page and the sidebar draw.
    var extensionItems: [ExtensionItem] {
        let c = channels.channels
        return ExtensionList.items(addons: addonCatalogue, telegram: c?.telegram, cliq: c?.cliq, voice: channels.voice,
                                   builtInAddons: Set(AddonRegistry.shared.apps.map(\.id)))
    }

    /// Sidebar rows under Extensions: the overview and each added extension's page.
    var extensionSections: [SettingsSection] { ExtensionList.sidebarSections(extensionItems) }

    /// Reads the add-on catalogue and the channels' state, so every card says what is true now.
    func refreshExtensions() async {
        async let a: Void = refreshAddons()
        async let c: Void = channels.refresh()
        async let v: Void = channels.refreshVoice()
        _ = await (a, c, v)
    }

    func isAddonOn(_ id: String) -> Bool { enabledAddons.contains(id) }

    /// Reads the catalogue now and again every half minute, so the Mac follows a change made elsewhere.
    func watchAddons() async {
        while !Task.isCancelled {
            await refreshAddons()
            try? await Task.sleep(for: .seconds(30))
        }
    }

    func refreshAddons() async {
        guard !demoMode, !captureMode else { return }
        do {
            guard let list = try await client.addons() else {
                addonsOldDaemon = true
                addonsLoaded = true
                await applyAddons([])
                return
            }
            addonsOldDaemon = false
            addonsLoaded = true
            addonCatalogue = list
            await applyAddons(Set(list.filter(\.enabled).map(\.id)))
        } catch {
            // The daemon is not answering: keep what was last known (the sources then read the host's files directly).
        }
    }

    /// Adds or removes an add-on; the daemon answers with the catalogue as it is then.
    func setAddon(_ id: String, enabled: Bool) async {
        let name = addonCatalogue.first { $0.id == id }?.name ?? id
        await runExtensionAction(id, name: name, adding: enabled) { [self] in
            if demoMode || captureMode {
                if enabled { enabledAddons.insert(id) } else { enabledAddons.remove(id) }
                addonCatalogue = addonCatalogue.map { var i = $0; if i.id == id { i.enabled = enabled }; return i }
                return
            }
            do {
                guard let list = try await client.setAddon(id: id, enabled: enabled) else {
                    extensionState.finish(id, error: "Update Squeak's background service to manage extensions.")
                    return
                }
                addonCatalogue = list
                await applyAddons(Set(list.filter(\.enabled).map(\.id)))
            } catch {
                extensionState.finish(id, error: "\(name): the Squeak service didn't answer. Try again.")
            }
        }
    }

    /// One card's action: only that card shows progress, it gives up after 15 s, and the card flips only when the
    /// state really changed; otherwise its own error says so.
    func runExtensionAction(_ id: String, name: String, adding: Bool, _ operation: @escaping @MainActor @Sendable () async -> Void) async {
        guard extensionState.begin(id) else { return }
        let done = await ExtensionActionState.finishes { await operation() }
        guard extensionState.isPending(id) else { return }  // the operation reported its own error
        if !done {
            extensionState.finish(id, error: ExtensionActionState.timedOutMessage(name))
            return
        }
        let now = extensionItems.first { $0.id == id }?.isAdded
        if let now, now != adding {
            extensionState.finish(id, error: channels.notice ?? ExtensionActionState.notDoneMessage(name, adding: adding))
        } else {
            extensionState.finish(id)
        }
    }

    /// Makes the sources, the watcher and the pages match `ids`.
    private func applyAddons(_ ids: Set<String>) async {
        guard ids != enabledAddons || !addonsApplied else { return }
        let added = ids.subtracting(enabledAddons)
        enabledAddons = ids
        addonsApplied = true
        UserDefaults.standard.set(ids.sorted(), forKey: "enabledAddons")
        let apps = enabledApps
        await broker.setAdapters(SessionSources.adapters(client: client, native: NativeHostClient.beside(client), addons: apps))
        startAddonWatcher()
        for app in apps where added.contains(app.id) { Task { await app.refreshPage() } }
        AppLog.info("add-ons on: \(ids.sorted().joined(separator: ", "))")
    }

    /// Read-only file-system events on the files the enabled add-ons watch; the timers keep running as the fallback.
    func startAddonWatcher() {
        addonWatcher?.stop()
        addonWatcher = nil
        let paths = enabledApps.flatMap(\.watchedPaths)
        guard !paths.isEmpty else { return }
        let broker = self.broker
        let watcher = FileChangeWatcher(paths: paths) { Task { await broker.nudge() } }
        watcher.start()
        addonWatcher = watcher
    }
}
