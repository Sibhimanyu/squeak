import Foundation
import Observation
import SqueakMacCore

// docs/ponds.md on the Mac: the pond routes' state for the window. Every project is a pond; the host keeps the
// local ones (nothing leaves this Mac until the first invite). With the host down or `SQUEAK_FLOTILLA=off` the lists
// stay empty and a project's home still works from its local chats.
// A singleton so the sidebar, the centre and the panel share it without widening AppModel.

enum PondSheet: Identifiable, Equatable {
    case invite(pondId: String)
    case join
    case startThread(pondId: String, pondName: String)

    var id: String {
        switch self {
        case .invite(let id): "invite:\(id)"
        case .join: "join"
        case .startThread(let id, _): "start:\(id)"
        }
    }
}

enum PondRoute: Equatable {
    /// A pond's home, by the project's name (a project need not be in a pond yet).
    case home(project: String)
    /// Another member's thread, or one of the pond's own, opened from home.
    case thread(project: String, pondId: String, threadId: String)
    /// A pond's settings page (DESIGN.md §8.10): saved as you change, back to the pond's home.
    case settings(project: String)
}

@MainActor @Observable
final class PondsModel {
    static let shared = PondsModel()

    /// True once the host answered `GET /ponds`.
    private(set) var available = false
    private(set) var ponds: [PondSummary] = [] {
        didSet {
            // A join that was waiting and is now active: one macOS notification each.
            for p in PondJoinWaiting.approved(old: oldValue, new: ponds) { Notifier.shared.postPondJoined(id: p.id, name: p.name) }
        }
    }
    /// Whether the host has a cloud store an invite could publish to (an older host does not say: assumed).
    private(set) var cloud = true
    /// Every project the sidebar lists, Conductor's too: each gets a pond.
    @ObservationIgnored var projectNames: [String] = [] { didSet { if oldValue != projectNames { Task { await ensureLocalPonds() } } } }
    /// An Invite that waits for the sign-in it started.
    @ObservationIgnored private var inviteAfterSignIn: String?
    private(set) var details: [String: PondDetail] = [:]
    var route: PondRoute?
    var sheet: PondSheet?
    /// A refusal or failure in the host's own words, quiet, under the home header.
    var note: String?
    /// Bumped for a pond when the host's stream says it changed: open threads read their events again.
    private(set) var changeTick: [String: Int] = [:]

    @ObservationIgnored private var client: PondsClient?
    @ObservationIgnored private var running = false

    // MARK: Lookup

    /// The native projects on this Mac, kept current by the sidebar, so a project finds its pond by id.
    @ObservationIgnored var projects: [NativeProject] = []

    /// The hue of the colour chosen for a pond, when one was.
    func colourHue(forPondId id: String) -> Double? {
        guard let pond = ponds.first(where: { $0.id == id }) else { return nil }
        let project = NativeWorkspaceMaking.project(named: pond.name, in: projects)
        if let hue = PondColours.hue(named: project?.colour) { return hue }
        // No chosen colour: the logo's dominant hue, when the pond has an icon.
        return PondIcons.shared.logoHues(for: project).first
    }

    func pond(named name: String) -> PondSummary? {
        PondLookup.pond(in: ponds, projectName: name, projects: projects)
    }

    func detail(named name: String) -> PondDetail? { pond(named: name).flatMap { details[$0.id] } }

    var homeProject: String? {
        switch route {
        case .home(let p), .thread(let p, _, _), .settings(let p): p
        case nil: nil
        }
    }

    // MARK: Loop

    /// Reads the list, then follows the host's change stream until the task is cancelled. Safe to call more than once.
    func run(host: NativeHostClient) async {
        guard !running else { return }
        running = true
        defer { running = false }
        let c = PondsClient(host: host)
        client = c
        await refresh()
        // A host without the routes is asked again slowly: the owner may turn the flag on.
        if !available {
            while !Task.isCancelled && !available {
                try? await Task.sleep(for: .seconds(60))
                await refresh()
            }
        }
        guard available else { return }
        let refresher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                await self?.refresh()
            }
        }
        defer { refresher.cancel() }
        for await pondId in c.changes() {
            changeTick[pondId, default: 0] += 1
            await refresh(pond: pondId)
        }
    }

    func refresh() async {
        guard let client else { return }
        do {
            guard let listing = try await client.listing() else { available = false; ponds = []; details = [:]; return }
            available = true
            cloud = listing.cloud
            ponds = listing.ponds
            let list = ponds
            for p in list where details[p.id] == nil || openPondIds.contains(p.id) { await load(p.id) }
            details = details.filter { id, _ in list.contains { $0.id == id } }
        } catch {
            // Down or unreadable: keep what was shown; the next change or minute reads again.
        }
    }

    /// Every project is a pond: makes the local pond of any project that has none (idempotent on the host).
    func ensureLocalPonds() async {
        guard let client, available else { return }
        let missing = LocalPondPlan.missing(names: projectNames, native: projects, ponds: ponds)
        guard !missing.isEmpty else { return }
        for m in missing { _ = try? await client.ensureLocal(name: m.name, projectId: m.projectId, rootPath: m.rootPath) }
        if let listing = try? await client.listing() { ponds = listing.ponds; cloud = listing.cloud }
    }

    func refresh(pond id: String) async {
        await load(id)
        if let client, let list = try? await client.ponds() { ponds = list }
    }

    private var openPondIds: Set<String> {
        if case .thread(_, let id, _)? = route { return [id] }
        if let p = homeProject, let id = pond(named: p)?.id { return [id] }
        return []
    }

    func load(_ id: String) async {
        guard let client else { return }
        if let d = try? await client.detail(id: id) { details[id] = d }
    }

    // MARK: Actions (each says why in the host's words when refused)

    private func attempt(_ what: () async throws -> Void) async -> Bool {
        guard client != nil else { return false }
        do { try await what(); note = nil; return true }
        catch let e as NativeHostError { note = e.reason; return false }
        catch { note = "That didn't go through"; return false }
    }

    /// The Invite button: no cloud says so; signed out signs in first and then continues; else the invite sheet.
    func startInvite(pondId: String, account: AccountModel) {
        switch PondInviteStart.decide(cloud: cloud, linked: account.state?.linked == true) {
        case .say(let sentence): note = sentence
        case .invite: note = nil; sheet = .invite(pondId: pondId)
        case .signIn:
            guard account.canSignIn else { note = PondWords.cantSignIn; return }
            note = nil
            inviteAfterSignIn = pondId
            account.afterSignIn = { [weak self] in
                guard let self, let id = self.inviteAfterSignIn else { return }
                self.inviteAfterSignIn = nil
                self.sheet = .invite(pondId: id)
            }
            account.openSignIn(from: .pond(ponds.first { $0.id == pondId }?.name ?? ""))
        }
    }

    func invite(pond: String, role: PondRole) async -> PondInvite? {
        guard let client else { return nil }
        do { note = nil; return try await client.invite(pond: pond, role: role) }
        catch let e as NativeHostError { note = e.reason; return nil }
        catch { note = "That didn't go through"; return nil }
    }

    func join(code: String, name: String) async -> PondJoinResult? {
        guard let client else { return nil }
        do { note = nil; return try await client.join(code: code, displayName: name) }
        catch let e as NativeHostError { note = e.reason; return nil }
        catch { note = "That didn't go through"; return nil }
    }

    /// Withdraws a pending join (or clears a declined one); true when it is gone.
    @discardableResult
    func cancelJoin(pond: String) async -> Bool {
        let ok = await attempt({ try await client!.cancelJoin(pond: pond) })
        if ok { await refresh() }
        return ok
    }

    func decideJoin(pond: String, request: String, approve: Bool, role: PondRole) async {
        if await attempt({ try await client!.decideJoin(pond: pond, request: request, approve: approve, role: role) }) { await refresh(pond: pond) }
    }

    func removeMember(pond: String, member: String) async {
        if await attempt({ try await client!.removeMember(pond: pond, member: member) }) { await refresh(pond: pond) }
    }

    func share(pond: String, sessionId: String) async {
        if await attempt({ try await client!.share(pond: pond, sessionId: sessionId) }) { await refresh(pond: pond) }
    }

    func setPrivate(pond: String, thread: String, isPrivate: Bool) async {
        if await attempt({ try await client!.setPrivate(pond: pond, thread: thread, isPrivate: isPrivate) }) { await refresh(pond: pond) }
    }

    @discardableResult
    func startThread(pond: String, text: String, agent: String, model: String, workspaceId: String? = nil) async -> Bool {
        let ok = await attempt({ _ = try await client!.startThread(pond: pond, text: text, agent: agent, model: model, workspaceId: workspaceId) })
        if ok { await refresh(pond: pond) } else { HeresayBridge.trouble() }
        return ok
    }

    // MARK: Threads

    func events(pond: String, thread: String, after: Int) async -> ThreadEventPage? {
        try? await client?.events(pond: pond, thread: thread, after: after)
    }

    /// True when queued; nil when it failed (the reason is in `note`).
    func send(pond: String, thread: String, text: String, mode: SendMode) async -> Bool? {
        guard let client else { return nil }
        do { note = nil; return try await client.send(pond: pond, thread: thread, text: text, mode: mode) }
        catch let e as NativeHostError { note = e.reason; HeresayBridge.trouble(); return nil }
        catch { note = "That didn't go through"; HeresayBridge.trouble(); return nil }
    }

    func hold(pond: String, thread: String, requestId: String) async -> (ok: Bool, heldBy: String?) {
        (try? await client?.hold(pond: pond, thread: thread, requestId: requestId)) ?? (false, nil)
    }

    func answer(pond: String, thread: String, requestId: String, answer: String) async -> PondAnswerResult? {
        guard let client else { return nil }
        do { note = nil; return try await client.answer(pond: pond, thread: thread, requestId: requestId, answer: answer) }
        catch let e as NativeHostError { note = e.reason; return nil }
        catch { note = "That didn't go through"; return nil }
    }

    func presence(pond: String, viewing: String?, typing: Bool) {
        guard let client else { return }
        Task { try? await client.presence(pond: pond, viewing: viewing, typingIn: typing ? viewing : nil) }
    }
}
