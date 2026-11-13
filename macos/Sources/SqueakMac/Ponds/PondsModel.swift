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
            // A request that was waiting and was decided, or a pond this person was removed from: one macOS notification each.
            for n in PondNotes.joiner(old: oldValue, new: ponds) { Notifier.shared.postPond(n) }
        }
    }
    /// Join requests already announced, so a re-read never tells the owner twice.
    @ObservationIgnored private var announcedJoins: Set<String> = []
    /// Reads in flight, and the ones that failed since the last good one: a pond with no data yet says so, never an empty flock.
    private(set) var reading: Set<String> = []
    private(set) var failed: Set<String> = []
    /// The list itself could not be read (nothing is known yet, or the last read failed).
    private(set) var listFailed = false
    /// What a press on Approve/Deny is doing right now, so its card says so before the host's word arrives.
    private(set) var pressing: [String: Bool] = [:]
    /// A removal, rename, leave, delete or key change that is running, by key, so none can be pressed twice.
    private(set) var busy: Set<String> = []
    /// The last result line of those, quiet, by pond id.
    private(set) var result: [String: String] = [:]
    /// Messages sent into other people's threads that the starter's Mac has not shown yet, by thread id.
    var outbox: [String: [PondOutgoing]] = [:]
    /// Whether the host has a cloud store an invite could publish to (an older host does not say: assumed).
    private(set) var cloud = true
    /// Every project the sidebar lists, Conductor's too: each gets a pond.
    @ObservationIgnored var projectNames: [String] = [] { didSet { if oldValue != projectNames { Task { await ensureLocalPonds() } } } }
    /// An Invite that waits for the sign-in it started.
    @ObservationIgnored private var inviteAfterSignIn: String?
    private(set) var details: [String: PondDetail] = [:] {
        didSet {
            for (id, d) in details where oldValue[id] != d {
                let before = oldValue[id]
                var notes = PondNotes.owner(pond: d.pond, old: before, new: d, seen: announcedJoins) + PondNotes.threads(pond: d.pond, old: before, new: d)
                // The first read of a pond announces only requests still waiting; a thread's change needs a before.
                if before == nil { notes = notes.filter { $0.kind == .joinRequest } }
                for n in notes { Notifier.shared.postPond(n) }
                announcedJoins.formUnion(d.joins.map(\.id))
            }
        }
    }

    /// How a pond's data stands right now (the strip above it).
    func freshness(_ pond: PondSummary?) -> PondFreshness {
        guard let pond else { return .live }
        return PondFreshness.of(detail: details[pond.id], pond: pond, reading: reading.contains(pond.id), failed: failed.contains(pond.id))
    }

    /// The sidebar badge and menu-bar count for a pond.
    func badge(_ pond: PondSummary?) -> Int { pond.map { PondBadge.count(pond: $0, detail: details[$0.id]) } ?? 0 }

    /// Every join request waiting on this person, across ponds they own, with the pond it is for.
    var allJoins: [(pond: PondSummary, join: JoinRequest)] {
        ponds.flatMap { p in (details[p.id].map { $0.myRole.canApproveJoins ? $0.joins : [] } ?? []).map { (p, $0) } }
    }
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
        // No chosen colour: the logo's most vivid hue, when the pond has an icon.
        return PondIcons.shared.vividHue(for: project) ?? PondIcons.shared.logoHues(for: project).first
    }

    /// The pond's logo-derived (or chosen) hue only when it has an icon or a chosen colour; nil means "today's tint".
    func accentHue(forPondId id: String) -> Double? { colourHue(forPondId: id) }

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
            guard let listing = try await client.listing() else { available = false; ponds = []; details = [:]; listFailed = false; return }
            available = true
            listFailed = false
            cloud = listing.cloud
            ponds = listing.ponds
            let list = ponds
            // Owners read every shared pond, so a request reaches the badge, the menu bar and a notification even with its home closed.
            for p in list where p.state == .active || p.state == .local {
                if details[p.id] == nil || openPondIds.contains(p.id) || PondBadge.readsJoins(p) { await load(p.id) }
            }
            details = details.filter { id, _ in list.contains { $0.id == id } }
        } catch {
            // Down or unreadable: keep what was shown and say so; the next change or minute reads again.
            listFailed = true
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
        reading.insert(id)
        defer { reading.remove(id) }
        do {
            if let d = try await client.detail(id: id) { details[id] = d; failed.remove(id) }
        } catch {
            // The last data stays on screen, marked; never an empty pond.
            failed.insert(id)
        }
    }

    /// Reads a pond again by hand ("Try again").
    func retry(_ id: String) { Task { await load(id) } }

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
        catch let e as NativeHostError { note = e.reason; await refresh(); return nil }
        catch { note = "That didn't go through"; await refresh(); return nil }
    }

    /// Withdraws a pending join (or clears a declined one); true when it is gone.
    @discardableResult
    func cancelJoin(pond: String) async -> Bool {
        let ok = await attempt({ try await client!.cancelJoin(pond: pond) })
        if ok { await refresh() }
        return ok
    }


    /// Join requests whose decision is on its way (this press, or the host still working on it): their buttons wait, so
    /// a second press cannot repeat it.
    private(set) var deciding: Set<String> = []

    func isDeciding(_ j: JoinRequest) -> Bool { deciding.contains(j.id) || j.isDeciding }

    /// "Approving…" from the instant of the press, then the host's own word (a failure says what to do).
    func decisionLine(_ j: JoinRequest) -> (text: String, failed: Bool)? { JoinCardText.decisionLine(j, pressing: pressing[j.id]) }

    /// The host answers at once ("working"); the card then says "Approving…" until the pond view no longer lists the
    /// request, or shows why the decision failed. A relay that takes 3-15 s a call can need over a minute for one.
    func decideJoin(pond: String, request: String, approve: Bool, role: PondRole) async {
        guard !deciding.contains(request) else { return }
        deciding.insert(request)
        pressing[request] = approve
        let name = details[pond]?.joins.first { $0.id == request }?.displayName ?? "They"
        defer { deciding.remove(request); pressing[request] = nil }
        guard await attempt({ try await client!.decideJoin(pond: pond, request: request, approve: approve, role: role) }) else { return }
        // Until the request is gone from a successful read (done) or the host says it failed, the card keeps saying what is happening.
        for _ in 0..<90 {
            await load(pond)
            if let list = details[pond]?.joins, !failed.contains(pond) {
                guard let j = list.first(where: { $0.id == request }) else {
                    result[pond] = approve ? "\(name) joined." : "\(name) was declined."
                    scheduleClear(pond)
                    break
                }
                if !j.isDeciding { break }
            }
            try? await Task.sleep(for: .seconds(2))
        }
        await refresh(pond: pond)
    }

    private func scheduleClear(_ key: String) {
        Task { try? await Task.sleep(for: .seconds(5)); result[key] = nil }
    }

    /// One owner action at a time per key; its result is a quiet line, its failure the host's sentence.
    private func act(_ key: String, pond: String, success: String?, _ work: @escaping () async throws -> Void) async -> Bool {
        guard !busy.contains(key) else { return false }
        busy.insert(key); result[pond] = nil
        defer { busy.remove(key) }
        guard await attempt(work) else { return false }
        if let success { result[pond] = success; scheduleClear(pond) }
        await refresh(pond: pond)
        return true
    }

    func isBusy(_ key: String) -> Bool { busy.contains(key) }

    func removeMember(pond: String, member: String) async {
        let name = details[pond]?.members.first { $0.id == member }?.name ?? "They"
        _ = await act("remove:\(pond):\(member)", pond: pond, success: "\(name) was removed.") { try await self.client!.removeMember(pond: pond, member: member) }
    }

    func setRole(pond: String, member: String, role: PondRole) async {
        let name = details[pond]?.members.first { $0.id == member }?.name ?? "They"
        _ = await act("role:\(pond):\(member)", pond: pond, success: "\(name) is now a \(role.word.lowercased()).") { try await self.client!.setRole(pond: pond, member: member, role: role) }
    }

    func revokeInvite(pond: String, invite: String) async {
        _ = await act("invite:\(pond):\(invite)", pond: pond, success: "Invite revoked. The link and code stop working.") { try await self.client!.revokeInvite(pond: pond, invite: invite) }
    }

    func rotateKey(pond: String) async {
        _ = await act("rotate:\(pond)", pond: pond, success: "The pond key was changed.") { try await self.client!.rotateKey(pond: pond) }
    }

    func rename(pond: String, name: String) async -> Bool {
        await act("rename:\(pond)", pond: pond, success: "Renamed.") { try await self.client!.rename(pond: pond, name: name) }
    }

    /// A member leaves; the pond goes from the list.
    func leave(pond: String) async -> Bool {
        let ok = await act("leave:\(pond)", pond: pond, success: nil) { try await self.client!.leave(pond: pond) }
        if ok { route = nil }
        return ok
    }

    func deletePond(pond: String) async -> Bool {
        let ok = await act("delete:\(pond)", pond: pond, success: nil) { try await self.client!.deletePond(pond: pond) }
        if ok { route = nil }
        return ok
    }

    /// Clears an ended pond (declined, expired, withdrawn, removed) from this Mac.
    @discardableResult
    func forget(pond: String) async -> Bool {
        var ok = await attempt({ try await self.client!.forget(pond: pond) })
        // A host without the route clears a declined request the old way.
        if !ok { ok = await attempt({ try await self.client!.cancelJoin(pond: pond) }) }
        if ok { await refresh() }
        return ok
    }

    func share(pond: String, sessionId: String, isPrivate: Bool = false) async {
        if await attempt({ try await client!.share(pond: pond, sessionId: sessionId, isPrivate: isPrivate) }) { await refresh(pond: pond) }
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

    /// Sends into a thread. The message shows under the composer with its state (sending, waiting for the starter's Mac,
    /// sent, or the reason it was refused); true when the host took it.
    func send(pond: String, thread: String, text: String, mode: SendMode) async -> Bool {
        guard let client else { return false }
        let item = PondOutgoing(text: text, sentAt: Date())
        outbox[thread, default: []].append(item)
        func set(_ s: PondOutgoing.State) { if let i = outbox[thread]?.firstIndex(where: { $0.id == item.id }) { outbox[thread]?[i].state = s } }
        do {
            let r = try await client.send(pond: pond, thread: thread, text: text, mode: mode)
            set(PondOutbox.state(for: r))
            return r.state != .refused
        } catch let e as NativeHostError {
            set(.refused(e.reason)); HeresayBridge.trouble(); return false
        } catch { set(.refused("That message wasn\u{2019}t sent.")); HeresayBridge.trouble(); return false }
    }

    func dismissOutgoing(thread: String, id: UUID) { outbox[thread]?.removeAll { $0.id == id } }

    func hold(pond: String, thread: String, requestId: String) async -> (ok: Bool, heldBy: String?) {
        guard let client else { return (false, nil) }
        do { return try await client.hold(pond: pond, thread: thread, requestId: requestId) }
        catch let e as NativeHostError { return (false, e.reason) }
        catch { return (false, nil) }
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
