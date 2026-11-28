import Foundation
import Observation
import SqueakMacCore

// docs/ponds.md on the Mac: the pond routes' state for the window. Every project is a pond; the host keeps the
// local ones (nothing leaves this Mac until the first invite). With the host down or `SQUEAK_FLOTILLA=off` the lists
// stay empty and a project's home still works from its local chats.
// A singleton so the sidebar, the centre and the panel share it without widening AppModel.

enum PondSheet: Identifiable, Equatable {
    case invite(pondId: String)
    case people(pondId: String)

    var id: String {
        switch self {
        case .invite(let id): "invite:\(id)"
        case .people(let id): "people:\(id)"
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
    /// Every archived thread across all ponds (the sidebar's Archived entry).
    case archived

    /// The route a location shows, if it is a pond page.
    init?(_ location: WorkbenchLocation) {
        switch location {
        case .pondHome(let p): self = .home(project: p)
        case .pondThread(let p, let id, let t): self = .thread(project: p, pondId: id, threadId: t)
        case .pondSettings(let p): self = .settings(project: p)
        case .archived: self = .archived
        case .home, .chat, .compose, .settings, .usage, .artifact: return nil
        }
    }

    var location: WorkbenchLocation {
        switch self {
        case .home(let p): .pondHome(pond: p)
        case .thread(let p, let id, let t): .pondThread(pond: p, pondId: id, threadId: t)
        case .settings(let p): .pondSettings(pond: p)
        case .archived: .archived
        }
    }
}

@MainActor @Observable
final class PondsModel {
    static let shared = PondsModel()

    /// Threads other people started that this person hid from their own view (never anyone else's). Kept on this Mac.
    private(set) var hides: SharedThreadHides = {
        (UserDefaults.standard.data(forKey: "sharedThreadHides")).flatMap { try? JSONDecoder().decode(SharedThreadHides.self, from: $0) } ?? SharedThreadHides()
    }()

    func hideShared(threadId: String, pondId: String, pondName: String, title: String, agent: String?) {
        hides.hide(SharedThreadHide(threadId: threadId, pondId: pondId, pondName: pondName, title: title, agent: agent, hiddenAt: Date()))
        saveHides()
    }

    func unhideShared(threadId: String) { hides.unhide(threadId); saveHides() }

    private func saveHides() { UserDefaults.standard.set(try? JSONEncoder().encode(hides), forKey: "sharedThreadHides") }

    /// True once the host answered `GET /ponds`.
    private(set) var available = false
    private(set) var ponds: [PondSummary] = [] {
        didSet {
            // A request that was waiting and was decided, or a pond this person was removed from: one macOS notification each.
            for n in PondNotes.joiner(old: oldValue, new: ponds) { Notifier.shared.postPond(n) }
        }
    }
    /// Join requests already announced, so a re-read never tells the owner twice.
    /// Reads in flight, and the ones that failed since the last good one: a pond with no data yet says so, never an empty flock.
    private(set) var reading: Set<String> = []
    /// Which of those reads the person should see a mark for (their own, or slow ones); `readTick` wakes the view when a quiet one turns slow.
    @ObservationIgnored private var readTracker = PondReadTracker()
    @ObservationIgnored private var readGate = PondReadGate()
    @ObservationIgnored private var changeDebounce: [String: Task<Void, Never>] = [:]
    private(set) var readTick = 0
    private(set) var failed: Set<String> = []
    /// The list itself could not be read (nothing is known yet, or the last read failed).
    private(set) var listFailed = false
    /// A removal, rename, leave, delete or key change that is running, by key, so none can be pressed twice.
    private(set) var busy: Set<String> = []
    /// The last result line of those, quiet, by pond id.
    private(set) var result: [String: String] = [:]
    /// Remove, leave and delete as the cloud has answered them (`PondActionTracker`): pending in place, a failure that stays
    /// with Try again, and a done line only after the host confirmed.
    private(set) var actions = PondActionTracker()
    /// Messages sent into other people's threads that the starter's Mac has not shown yet, by thread id.
    var outbox: [String: [PondOutgoing]] = [:]
    /// Whether the host has a cloud store an invite could publish to (an older host does not say: assumed).
    private(set) var cloud = true
    /// The pond directory (`GET /native/directory`): the one list every pond row, home and setting is drawn from. The last good
    /// read stays while the host is down. Nothing matches a pond by name; a pond's key is its directory id.
    private(set) var directory: PondDirectory? {
        didSet {
            if oldValue?.pondOwnThreads != directory?.pondOwnThreads { ponds = PondOwnThreads.adjusted(ponds, ownThreads: ownThreads) }
            // Ducks mode changes how the tree is built: every derived list and the focus read again.
            if oldValue?.ducksMode != directory?.ducksMode { AppModel.shared.inputsChanged() }
            if let directory { freshPonds.prune(listed: directory.liveKeys, now: Date()) }
            if directory != nil, directoryLoad.loaded { AppModel.shared.prunePonds(live: liveKeys) }
            if directory != nil { AppModel.shared.flushPendingTabs() }
        }
    }
    /// Invitations waiting for this account, as the Invitations block reads them from the cloud. First launch looks here to
    /// decide whether the person was invited (`SetupFlow.entry`); it is the same list the block draws.
    var pendingInvitationCount: Int { PondInvitations.toAnswer(invitations).count }
    /// Ponds this person made on this Mac, and Ponds other people shared with them (first launch reads both).
    var ownPondCount: Int { directory?.ponds.filter { !$0.isJoined }.count ?? 0 }
    var joinedPondCount: Int { directory?.ponds.filter(\.isJoined).count ?? 0 }
    /// Stashed own-Mac threads: the daemon's word (docs/ponds.md); every pond list is read through it.
    var ownThreads: Bool { PondOwnThreads.enabled(directory?.pondOwnThreads) }
    /// An Invite that waits for the sign-in it started.
    @ObservationIgnored private var inviteAfterSignIn: String?
    private(set) var details: [String: PondDetail] = [:] {
        didSet {
            for (id, d) in details where oldValue[id] != d {
                let before = oldValue[id]
                let notes0 = PondNotes.owner(pond: d.pond, old: before, new: d) + PondNotes.threads(pond: d.pond, old: before, new: d)
                // A change needs a before: the first read of a pond announces nothing.
                let notes = before == nil ? [] : notes0
                for n in notes { Notifier.shared.postPond(n) }
            }
        }
    }

    /// How a pond's data stands right now (the strip above it).
    func freshness(_ pond: PondSummary?) -> PondFreshness {
        guard let pond else { return .live }
        return PondFreshness.of(detail: details[pond.id], pond: pond, reading: reading.contains(pond.id), failed: failed.contains(pond.id))
    }

    /// The dashboard header's state for a pond: a fixed line, an info mark and the small indicator (never a row).
    func headerStatus(_ pond: PondSummary?, access: String) -> PondHeaderStatus {
        _ = readTick
        let id = pond?.id ?? ""
        return PondHeaderStatus.make(
            access: access, local: pond.map { $0.sharingState != .shared } ?? true, offer: pond.map { PondStartThread.offer(for: $0) },
            freshness: freshness(pond), readShown: readTracker.isShown(id))
    }

    /// The sidebar badge and menu-bar count for a pond.
    func badge(_ pond: PondSummary?) -> Int { pond.map { PondBadge.count(pond: $0, detail: details[$0.id]) } ?? 0 }

    /// Bridge for `PondThreadView.swift`, which sets it (reads and every other writer go through `AppModel.location`,
    /// `AppModel.openPond` and `closePondPage`). Delete once that file calls `AppModel.openPondHome`.
    var route: PondRoute? {
        get { PondRoute(AppModel.shared.baseLocation) }
        set { if let newValue { AppModel.shared.openPond(newValue) } else { AppModel.shared.closePondPage() } }
    }
    var sheet: PondSheet?
    /// A refusal or failure in the host's own words, quiet, under the home header.
    var note: String?
    /// Bumped for a pond when the host's stream says it changed: open threads read their events again.
    private(set) var changeTick: [String: Int] = [:]

    @ObservationIgnored private var client: PondsClient?
    @ObservationIgnored private var running = false

    // MARK: Your devices (Settings; the account's, never a Pond's)

    private(set) var yourDevices: [AccountDevice] = []
    /// nil until the first read; true when the last read failed (the list keeps what it had).
    private(set) var yourDevicesFailed: Bool?
    private(set) var removingDevice: String?
    private(set) var deviceNote: String?

    // MARK: Lookup

    /// The native projects on this Mac, kept current by the sidebar, so a project finds its pond by id.
    @ObservationIgnored var projects: [NativeProject] = []

    /// The colour a pond's look starts from: the one the person chose (a name, an old hue, or a real `#rrggbb`), else the
    /// logo's accent colour, as it is. Nil with no icon or choice: "today's tint".
    func seed(forPondId id: String) -> PondSeed? {
        let project = directory?.pond(pondId: id).flatMap { d in projects.first { $0.id == d.projectId } }
        return seed(of: project)
    }

    func accentSeed(forPondId id: String) -> PondSeed? { seed(forPondId: id) }

    /// The same for a directory key (a project id, or a joined pond's own id), as the sidebar and the open chat name a
    /// pond; a local pond has no pond id yet, so it is found by its project.
    func seed(forKey key: String) -> PondSeed? {
        let entry = directory?.pond(id: key) ?? directory?.pond(pondId: key)
        return seed(of: projects.first { $0.id == (entry?.projectId ?? key) })
    }

    private func seed(of project: NativeProject?) -> PondSeed? {
        if let s = PondColours.seed(named: project?.colour) { return s }
        return PondIcons.shared.logoColours(for: project).first.map(PondSeed.colour)
    }

    /// The directory row of a pond key (a project id, or a joined pond's own id).
    func entry(_ key: String) -> PondDirectory.Pond? { directory?.pond(id: key) }

    /// The directory key of a pond record (a project's, else its own id for a joined pond).
    func key(forPond pond: PondSummary) -> String {
        directory?.pond(pondId: pond.id)?.id ?? pond.projectId ?? pond.id
    }

    /// The directory key of a native project.
    func key(forProject id: String) -> String { directory?.pond(projectId: id)?.id ?? id }

    /// The pond record behind a key (invites, members, relay); nil for a project with no record yet.
    func pond(key: String) -> PondSummary? {
        if let id = entry(key)?.pondId { return ponds.first { $0.id == id } }
        return ponds.first { $0.id == key }
    }

    func detail(key: String) -> PondDetail? { pond(key: key).flatMap { details[$0.id] } }

    /// This person's name: the Squeak account's (the daemon's "you" in any pond), never the Mac's user name. Empty until a pond says it.
    var myName: String { PersonName.mine(in: Array(details.values)) }

    /// How this person belongs to a pond: the directory's `access`, else own / joined (`PondDirectory.Pond.membership`).
    func membership(of key: String) -> PondMembership {
        (directory?.pond(id: key) ?? directory?.pond(pondId: key))?.membership ?? .owner
    }

    /// Which chrome a pond shows (`PondChrome`): its access, the owner's name, and what this member's caps allow.
    func chrome(key: String) -> PondChrome {
        let pond = pond(key: key)
        let detail = detail(key: key)
        // What this person may do is the daemon's answer (`me.can`); the role only stands in for an older daemon, inside `PondCan`.
        let can = detail?.can ?? PondCan(role: pond?.role ?? .owner)
        var chrome = PondChrome(access: membership(of: key), ownerName: pond.flatMap(PondSharing.sharerName), can: can, policy: detail?.myPolicy)
        if !chrome.canMessage, chrome.reason == nil { chrome.reason = ThreadAccess.watchLine }
        return chrome
    }

    /// What the pond is called: the directory's name.
    func name(key: String) -> String { entry(key)?.name ?? ponds.first { $0.id == key }?.name ?? "" }

    /// The native project behind a key, by the directory's project id.
    /// The folder a terminal from this pond's page opens in (project root = Main, or the plain folder); nil = none here.
    static func pondTerminalFolder(_ key: String) -> String? {
        let m = shared
        return PondTerminal.availability(nativeRoot: m.native(key: key)?.rootPath, directoryFolder: m.entry(key)?.folder).folder
    }

    func native(key: String) -> NativeProject? {
        (entry(key)?.projectId ?? key).flatMap { id in projects.first { $0.id == id } }
    }

    /// The pond key a chat sits under, by the directory's placement (nil = Other).
    func key(of session: HostSession) -> String? {
        directory?.place(sessionKey: session.key.hostSessionId, cwd: session.cwd, pondId: session.pondId)
    }

    /// Demo and capture runs have no host: the directory is made from the demo projects (id = project id).
    func useDemoDirectory(_ list: [NativeProject]) {
        directory = PondDirectory(ponds: list.map { PondDirectory.Pond(id: $0.id, name: $0.name, projectId: $0.id, hidden: $0.hidden, labels: $0.labels, folder: $0.rootPath) })
    }

    /// True when the directory has loaded and has no pond under `key`: its page must not draw.
    func isGone(_ key: String) -> Bool {
        guard directoryLoad.loaded, let directory else { return false }
        return !(liveKeys?.contains(key) ?? true)
    }

    /// Ponds this Mac just made that the directory read it holds does not list yet (`FreshPonds`).
    private(set) var freshPonds = FreshPonds()

    /// What a place may point at: the loaded directory's keys plus a pond made moments ago. Nil until the directory loads.
    var liveKeys: Set<String>? { directoryLoad.loaded ? freshPonds.live(directory: directory?.liveKeys, now: Date()) : nil }

    /// A pond this Mac made: held live until the directory lists it, and the directory is read again now.
    func noteMade(keys: [String]) async {
        for key in keys { freshPonds.add(key, at: Date()) }
        await refreshDirectory()
    }

    /// What the directory load has seen so far; the sidebar reads it to tell "loading" from "no ponds".
    private(set) var directoryLoad = DirectoryLoad()
    private var directoryRetry: Task<Void, Never>?

    /// Reads the directory; until the first success it is asked again on a backoff (0.5, 1, 2, 4, then every 8 s).
    /// One load at a time, and a failure never clears the last good directory.
    func refreshDirectory() async {
        guard let client, directoryLoad.begin() else { return }
        do {
            if let d = try await client.directory() {
                directoryLoad.succeeded()
                if d != directory { directory = d }
            } else {
                directoryLoad.unsupportedHost()
            }
        } catch {
            directoryLoad.failed()
            if directoryLoad.needsRetry, directoryRetry == nil {
                let delay = directoryLoad.nextDelay
                directoryRetry = Task { [weak self] in
                    try? await Task.sleep(for: .seconds(delay))
                    guard !Task.isCancelled, let self else { return }
                    self.directoryRetry = nil
                    await self.refreshDirectory()
                }
            }
        }
    }

    /// The pond key the open page is for (`WorkbenchFocus.pond`): its home, a thread, a creation page aimed at it, or a chat in it.
    var homeProject: String? { AppModel.shared.focus.pond }

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
        // The host's stream says when anything changes; this is only the net under it, so it is slow, and the
        // owner's join requests (which also arrive on the stream) are re-read on every third look.
        let refresher = Task { [weak self] in
            var looks = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(120))
                looks += 1
                await self?.refresh()
            }
        }
        defer { refresher.cancel() }
        for await pondId in c.changes() {
            // A burst of change events is one read, 500 ms after the last.
            changeDebounce[pondId]?.cancel()
            changeDebounce[pondId] = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(500))
                guard !Task.isCancelled, let self else { return }
                self.changeTick[pondId, default: 0] += 1
                await self.refresh(pond: pondId)
            }
        }
    }

    func refresh() async {
        guard let client else { return }
        await refreshDirectory()
        do {
            guard let listing = try await client.listing() else { available = false; ponds = []; details = [:]; listFailed = false; return }
            available = true
            listFailed = false
            cloud = listing.cloud
            if !syncedAccount { syncedAccount = true; syncAccount() }
            let listed = PondOwnThreads.adjusted(listing.ponds, ownThreads: ownThreads)
            if ponds != listed { ponds = listed }
            await refreshInvitations()
            let list = ponds
            // Owners read every shared pond, so a request reaches the badge, the menu bar and a notification even with its home closed.
            for p in list where p.state == .active || p.state == .local {
                if details[p.id] == nil || openPondIds.contains(p.id) { await load(p.id) }
            }
            if details.keys.contains(where: { id in !list.contains { $0.id == id } }) {
                details = details.filter { id, _ in list.contains { $0.id == id } }
            }
        } catch {
            // Down or unreadable: keep what was shown and say so; the next change or minute reads again.
            listFailed = true
        }
    }

    func refresh(pond id: String, byPerson: Bool = false) async {
        await load(id, byPerson: byPerson)
        if let client, let fetched = try? await client.ponds() { let list = PondOwnThreads.adjusted(fetched, ownThreads: ownThreads); if list != ponds { ponds = list } }
    }

    private var openPondIds: Set<String> {
        if case .thread(_, let id, _)? = route { return [id] }
        if AppModel.shared.location.isPondRoute, let p = AppModel.shared.location.pondKey, let id = pond(key: p)?.id { return [id] }
        return []
    }

    func load(_ id: String, byPerson: Bool = false) async {
        guard let client else { return }
        // One read of a pond at a time; a request during one is folded into one more after it.
        guard readGate.request(id) else { if byPerson { readTracker.begin(id, byPerson: true); readTick += 1 }; return }
        repeat {
            // Only a read with nothing on screen yet, or the person's own, touches observed state; a background
            // refresh of a pond already drawn changes nothing until data differs.
            let visibleStart = byPerson || details[id] == nil
            if visibleStart { reading.insert(id) }
            readTracker.begin(id, byPerson: byPerson)
            if visibleStart { readTick += 1 }
            if let at = readTracker.showsAt(id) {
                // A background read still going after `quietFor` gets its mark then.
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(max(0, at.timeIntervalSinceNow) + 0.05))
                    guard let self, self.readTracker.isReading(id) else { return }
                    self.reading.insert(id)
                    self.readTick += 1
                }
            }
            do {
                if let d = try await client.detail(id: id) {
                    if details[id] != d { details[id] = d }
                    if failed.contains(id) { failed.remove(id) }
                    openRequested(in: d)
                    // People follow the Pond whenever its page is open (the Dashboard's avatars and the People sheet draw them).
                    if openPondIds.contains(id) { await loadPeople(id) }
                }
            } catch {
                // The last data stays on screen, marked; never an empty pond.
                if !failed.contains(id) { failed.insert(id) }
            }
            let wasShown = reading.contains(id)
            readTracker.end(id)
            if wasShown { reading.remove(id); readTick += 1 }
        } while readGate.finish(id)
    }

    /// Reads a pond again by hand ("Try again").
    func retry(_ id: String) { Task { await load(id, byPerson: true) } }

    // MARK: Actions (each says why in the host's words when refused)

    private func attempt(_ what: () async throws -> Void) async -> Bool {
        guard client != nil else { return false }
        do { try await what(); note = nil; return true }
        catch let e as NativeHostError { note = e.reason; return false }
        catch { note = "That didn't go through"; return false }
    }

    /// The Invite button: no cloud says so; signed out signs in first and then continues; else the invite sheet.
    func startInvite(pondId: String, account: AccountModel) {
        switch PondInviteStart.decide(cloud: cloud, linked: account.state?.linked == true,
                                         hostedReady: AppModel.shared.cloud.hosted?.phase == .ready) {
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

    /// Invitations for this Mac's account (docs/ponds.md "Invitations"): the ones to answer, and joined ones still opening.
    /// The host reads them from the relay's one record; nothing here decides anything.
    private(set) var invitations: [PondInvitation] = [] {
        didSet {
            // One notification per invite, ever: the announced ids are kept between launches.
            let seen = Set(UserDefaults.standard.stringArray(forKey: "announcedInvitations") ?? [])
            let r = PondInvitations.notes(list: invitations, seen: seen)
            if r.seen != seen { UserDefaults.standard.set(Array(r.seen), forKey: "announcedInvitations") }
            for n in r.notes { Notifier.shared.postPond(n) }
        }
    }
    /// The invitations that wait on this person's answer (Join or Decline).
    var invitationsToAnswer: [PondInvitation] { PondInvitations.toAnswer(invitations) }
    private(set) var answering: Set<String> = []

    /// The daemon could not read the cloud on the last read: the list is its last good one (the block says so, quietly).
    private(set) var invitationsStale = false
    /// The last Join or Decline was refused: its sentence (`note`) stays visible even when the row left the list.
    private(set) var invitationRefused = false

    /// Asks the daemon; its answer is the invitation's fresh view. A refusal gives the sentence in `note` and, when the daemon
    /// sent one, the view too.
    private func answerInvitation(_ call: (PondsClient) async throws -> PondInvitation?) async -> (ok: Bool, view: PondInvitation?) {
        guard let client else { return (false, nil) }
        do { let view = try await call(client); note = nil; return (true, view) }
        catch let refusal as PondInvitationRefusal { note = refusal.sentence; invitationRefused = true; return (false, refusal.invitation) }
        catch let e as NativeHostError { note = e.reason; return (false, nil) }
        catch { note = "That didn't go through"; return (false, nil) }
    }

    /// The row takes the daemon's answer at once (replaced, or dropped when no longer pending or joined); an answer without a
    /// view sends us to read.
    private func settle(_ view: PondInvitation?) async {
        if let view { invitations = PondInvitations.applying(view, to: invitations) } else { await refreshInvitations() }
    }

    /// Join: the row shows the daemon's answer without waiting for a re-read, then the Pond home opens.
    func join(invitation id: String) async {
        guard !answering.contains(id) else { return }
        answering.insert(id); note = nil; invitationRefused = false
        defer { answering.remove(id) }
        let before = invitations.first { $0.id == id }
        let answer = await answerInvitation { try await $0.joinInvitation(id: id) }
        await settle(answer.view)
        guard answer.ok else { return }
        await refresh()
        if let pond = answer.view?.pondId ?? before?.pondId ?? ponds.first(where: { $0.connecting })?.id,
           let row = ponds.first(where: { $0.id == pond }) {
            AppModel.shared.openPondHome(key(forPond: row))
        }
    }

    func decline(invitation id: String) async {
        guard !answering.contains(id) else { return }
        answering.insert(id); note = nil; invitationRefused = false
        defer { answering.remove(id) }
        let answer = await answerInvitation { try await $0.declineInvitation(id: id) }
        await settle(answer.view)
    }

    func refreshInvitations(fresh: Bool = false) async {
        guard let client, let answer = try? await client.invitations(fresh: fresh) else { return }
        if answer.stale != invitationsStale { invitationsStale = answer.stale }
        if answer.invitations != invitations { invitations = answer.invitations }
    }

    /// "Try again" under a stale list: the daemon tries the cloud before it answers.
    func retryInvitations() async { await refreshInvitations(fresh: true) }

    private func scheduleClear(_ key: String) {
        Task { try? await Task.sleep(for: .seconds(5)); result[key] = nil }
    }

    /// One owner action at a time per key; its result is a quiet line, its failure the host's sentence.
    private func act(_ key: String, pond: String, success: String?, kind: PondActionKind? = nil, who: String? = nil,
                     _ work: @escaping () async throws -> Void) async -> Bool {
        guard !busy.contains(key) else { return false }
        busy.insert(key); result[pond] = nil
        if let kind { actions.begin(key, kind, who: who) }
        defer { busy.remove(key) }
        guard await attempt(work) else {
            if kind != nil { actions.fail(key, reason: note); note = nil }
            return false
        }
        if kind != nil { actions.confirm(key); clearAction(key) }
        if let success { result[pond] = success; scheduleClear(pond) }
        await refresh(pond: pond, byPerson: true)
        await loadPeople(pond)
        return true
    }

    private func clearAction(_ key: String) {
        Task { try? await Task.sleep(for: .seconds(5)); actions.clear(key) }
    }

    /// Try again on a failed remove, leave or delete: the same press, pending in place again.
    func retry(action key: String, pond: String) async {
        guard actions.offersTryAgain(key) else { return }
        let parts = key.split(separator: ":").map(String.init)
        switch parts.first {
        case "remove": if parts.count == 3 { await removeMember(pond: parts[1], member: parts[2]) }
        case "resend", "withdraw", "again":
            guard parts.count == 3, let invite = people[parts[1]]?.invites.first(where: { $0.id == parts[2] }) else { break }
            await inviteAction(parts[0] == "resend" ? .resend : parts[0] == "withdraw" ? .withdraw : .inviteAgain, pond: parts[1], invite: invite)
        case "leave": _ = await leave(pond: pond)
        case "delete": _ = await deletePond(pond: pond)
        default: break
        }
    }

    private var syncedAccount = false

    func isBusy(_ key: String) -> Bool { busy.contains(key) }

    func removeMember(pond: String, member: String) async {
        let name = details[pond]?.members.first { $0.id == member }?.name ?? "They"
        _ = await act("remove:\(pond):\(member)", pond: pond, success: "\(name) was removed.", kind: .remove, who: name) { try await self.client!.removeMember(pond: pond, member: member) }
    }

    /// Owner: a Member's waiting Duck is approved (it starts) or declined (the Room says so).
    func decideStart(pond: String, request: String, approve: Bool) async {
        _ = await act("start:\(pond):\(request)", pond: pond, success: approve ? "Duck approved." : "Duck declined.") {
            if approve { try await self.client!.approveStart(pond: pond, request: request) }
            else { try await self.client!.declineStart(pond: pond, request: request) }
        }
    }

    /// Owner: the Pond's two settings (Pond settings, Permissions). The daemon's answer is what shows.
    func setPolicy(pond: String, reach: ReachDucks? = nil, start: StartDucks? = nil) async {
        _ = await act("policy:\(pond)", pond: pond, success: nil) { try await self.client!.setPolicy(pond: pond, body: PondPermissions.body(reach: reach, start: start)) }
    }

    /// Owner: one person's own setting, or `Same as the Pond` (nil) to clear it.
    func setOverride(pond: String, member: String, reach: PondOverrideChange<ReachDucks> = .keep, start: PondOverrideChange<StartDucks> = .keep) async {
        _ = await act("policy:\(pond):\(member)", pond: pond, success: nil) {
            try await self.client!.setPolicy(pond: pond, body: PondPermissions.overrideBody(member: member, reach: reach, start: start))
        }
    }

    func setRole(pond: String, member: String, role: PondRole) async {
        let name = details[pond]?.members.first { $0.id == member }?.name ?? "They"
        _ = await act("role:\(pond):\(member)", pond: pond, success: "\(name) is now a \(role.word.lowercased()).") { try await self.client!.setRole(pond: pond, member: member, role: role) }
    }

    // MARK: People and invites (docs/spec.md "People and remote")

    /// Each Pond's People as the host last answered (members with presence and roles, the relay's invite records).
    private(set) var people: [String: PondPeople] = [:]

    /// Reads the Pond's people again; the last answer stays when the host cannot give one.
    func loadPeople(_ pond: String) async {
        guard let client else { return }
        if let p = try? await client.people(pond: pond), people[pond] != p { people[pond] = p }
    }

    /// The Invite sheet's Send: the tracker says Inviting… in place and keeps a failure with Try again. Answers one outcome per
    /// address (a refused address is `ok: false` with its sentence); nil when nothing could be asked.
    func sendInvites(pond: String, emails: [String], role: PondRole) async -> [PondInviteOutcome]? {
        let key = "invite:\(pond)"
        guard let client, !busy.contains(key) else { return nil }
        busy.insert(key); actions.begin(key, .invite)
        defer { busy.remove(key) }
        do {
            let results = try await client.invite(pond: pond, emails: emails, role: role)
            actions.clear(key)
            await loadPeople(pond)
            await refresh(pond: pond, byPerson: true)
            return results
        } catch {
            actions.fail(key, reason: (error as? NativeHostError)?.reason)
            return nil
        }
    }

    /// Resend, Withdraw and Invite again on one invite row: pending in place, a failure that stays with Try again.
    func inviteAction(_ action: PeopleSheetPlan.InviteAction, pond: String, invite: PondInviteRecord) async {
        let (verb, kind): (String, PondActionKind) = switch action {
        case .resend: ("resend", .resend)
        case .withdraw: ("withdraw", .withdraw)
        case .inviteAgain: ("again", .invite)
        }
        _ = await act("\(verb):\(pond):\(invite.id)", pond: pond, success: nil, kind: kind, who: invite.email) {
            switch action {
            case .resend: _ = try await self.client!.resendInvite(pond: pond, invite: invite.id)
            case .withdraw: _ = try await self.client!.withdrawInvite(pond: pond, invite: invite.id)
            case .inviteAgain: _ = try await self.client!.inviteAgain(pond: pond, invite: invite.id)
            }
        }
    }

    func rotateKey(pond: String) async {
        _ = await act("rotate:\(pond)", pond: pond, success: "The pond key was changed.") { try await self.client!.rotateKey(pond: pond) }
    }

    func rename(pond: String, name: String) async -> Bool {
        await act("rename:\(pond)", pond: pond, success: "Renamed.") { try await self.client!.rename(pond: pond, name: name) }
    }

    /// A member leaves; the pond goes from the list.
    func leave(pond: String) async -> Bool {
        let ok = await act("leave:\(pond)", pond: pond, success: nil, kind: .leave) { try await self.client!.leave(pond: pond) }
        if ok { route = nil }
        return ok
    }

    /// "Leave pond…": leaves the pond (`POST /ponds/<id>/leave`), drops it from the sidebar at once and opens the Dashboard.
    /// Never for the person's own pond.
    func leaveAndDrop(key: String) async -> Bool {
        guard membership(of: key) != .owner else { return false }
        let id = (directory?.pond(id: key) ?? directory?.pond(pondId: key))?.pondId ?? pond(key: key)?.id ?? key
        guard await leave(pond: id) else { return false }
        await dropGone(id: id, key: key)
        return true
    }

    /// A pond that is gone (left, deleted): out of the directory and the list at once (the directory's change prunes every
    /// place that pointed at it), the Dashboard, then the host's word.
    private func dropGone(id: String, key: String? = nil) async {
        let key = key ?? id
        if var d = directory { d.ponds.removeAll { $0.id == key || $0.id == id || $0.pondId == id }; directory = d }
        ponds.removeAll { $0.id == id }
        if let live = liveKeys { AppModel.shared.prunePonds(live: live) }
        else if AppModel.shared.location.pondKey == key || AppModel.shared.location.pondKey == id { WorkbenchNav.goHome(AppModel.shared) }
        await refreshDirectory()
    }

    func removeMyDevice(pond: String, deviceKeyId: String) async {
        _ = await act("device:\(pond):\(deviceKeyId)", pond: pond, success: "Device removed.") { try await self.client!.removeMyDevice(pond: pond, deviceKeyId: deviceKeyId) }
    }

    /// Reads the account's devices from the host; the list keeps what it had when the cloud will not answer.
    func loadDevices() async {
        guard let client else { return }
        do {
            if let list = try await client.accountDevices() { yourDevices = list; yourDevicesFailed = false }
            else { yourDevicesFailed = true }
        } catch { yourDevicesFailed = true }
    }

    /// Removes a device everywhere. The row goes only after the cloud confirmed (the host answers after the relay did).
    func removeDevice(_ id: String) async {
        guard let client, removingDevice == nil else { return }
        removingDevice = id; deviceNote = nil
        defer { removingDevice = nil }
        do { try await client.removeAccountDevice(id: id) }
        catch { deviceNote = (error as? NativeHostError)?.reason ?? "Squeak couldn't remove that device. Try again."; return }
        await loadDevices()
    }

    /// Fire and forget: ponds joined in a browser appear. Failures are silent.
    func syncAccount() {
        guard let client else { return }
        Task { if let n = try? await client.syncAccount(), n > 0 { await self.refresh() } }
    }

    func deletePond(pond: String) async -> Bool {
        // A local Pond's Delete is Remove from Squeak (the daemon runs the host's removal): the project and the row leave together.
        let ok = await act("delete:\(pond)", pond: pond, success: nil, kind: .delete) { try await self.client!.deletePond(pond: pond) }
        if ok {
            await AppModel.shared.refreshNativeProjects()
            await dropGone(id: pond)
        }
        return ok
    }

    /// The one End for a Pond: whatever the daemon offers it (Delete, Leave or Remove). The view draws the offer's words and
    /// calls this; nothing here decides local versus shared.
    func endPond(pond: String) async -> Bool {
        switch ponds.first(where: { $0.id == pond })?.endOffering.primary ?? .leave {
        case .delete: return await deletePond(pond: pond)
        case .leave: return await leave(pond: pond)
        case .forget: return await forget(pond: pond)
        }
    }

    /// The same by a directory key (the sidebar), dropping the row once it is done.
    func endAndDrop(key: String) async -> Bool {
        let id = (directory?.pond(id: key) ?? directory?.pond(pondId: key))?.pondId ?? pond(key: key)?.id ?? key
        guard let p = ponds.first(where: { $0.id == id }) else { return false }
        switch p.endOffering.primary {
        case .leave: return await leaveAndDrop(key: key)
        case .delete: return await deletePond(pond: id)
        case .forget: return await forget(pond: id)
        }
    }

    /// Clears an ended pond (declined, expired, withdrawn, removed) from this Mac.
    @discardableResult
    func forget(pond: String) async -> Bool {
        let ok = await attempt({ try await self.client!.forget(pond: pond) })
        if ok { await refresh() }
        return ok
    }

    func share(pond: String, sessionId: String, isPrivate: Bool = false) async {
        if await attempt({ try await client!.share(pond: pond, sessionId: sessionId, isPrivate: isPrivate) }) { await refresh(pond: pond, byPerson: true) }
    }

    func setPrivate(pond: String, thread: String, isPrivate: Bool) async {
        if await attempt({ try await client!.setPrivate(pond: pond, thread: thread, isPrivate: isPrivate) }) { await refresh(pond: pond, byPerson: true) }
    }

    @discardableResult
    func startThread(pond: String, text: String, agent: String, model: String, workspaceId: String? = nil,
                     effort: String? = nil, permissionMode: String? = nil, split: WorkSplit? = nil, isPrivate: Bool = false,
                     main: Bool = false, place: DuckPlace? = nil) async -> Bool {
        await startedThread(pond: pond, text: text, agent: agent, model: model, workspaceId: workspaceId, effort: effort,
                            permissionMode: permissionMode, split: split, isPrivate: isPrivate, main: main, place: place).ok
    }

    /// Starts the thread and returns what the host made, so the caller can open that Duck's page. `ok` is false when the
    /// host did not take it (`note` says why); `thread` is nil from a host that answers without one.
    func startedThread(pond: String, text: String, agent: String, model: String, workspaceId: String? = nil,
                       effort: String? = nil, permissionMode: String? = nil, split: WorkSplit? = nil, isPrivate: Bool = false,
                       main: Bool = false, place: DuckPlace? = nil) async -> (ok: Bool, thread: PondThread?) {
        var made: PondThread?
        let ok = await attempt({
            made = try await client!.startThread(pond: pond, text: text, agent: agent, model: model, workspaceId: workspaceId,
                                                 effort: effort, permissionMode: permissionMode, split: split, isPrivate: isPrivate, main: main, place: place)
        })
        if ok { await refresh(pond: pond, byPerson: true) } else { HeresayBridge.trouble() }
        return (ok, made)
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

    // MARK: Changes of someone else's thread

    /// Asks the thread's starter for what changed (and one file's patch). Your own thread answers at once.
    func askChanges(pond: String, thread: String, path: String? = nil) async -> PondChangesReply? {
        try? await client?.requestChanges(pond: pond, thread: thread, path: path)
    }

    /// The starter's answer, once the pond says it changed; nil while it has not come or lapsed.
    func readChanges(pond: String, thread: String, request: String) async -> PondChanges? {
        try? await client?.changes(pond: pond, thread: thread, request: request)
    }

    // MARK: A thread that runs on the owner's Mac

    struct PendingStart: Equatable {
        var pondId: String
        var project: String
        var ownerName: String?
        var askedAt: Date
    }
    /// Requests the owner's Mac has not answered yet, by request id; the thread opens when it shows up.
    private(set) var pendingStarts: [String: PendingStart] = [:]

    /// Asks the owner's Mac to start the thread. True when the request went out; the thread opens when it appears.
    func requestStart(pond: PondSummary, text: String, agent: String, model: String) async -> Bool {
        guard let client else { return false }
        do {
            let id = try await client.requestStart(pond: pond.id, text: text, agent: agent, model: model)
            note = nil
            pendingStarts[id] = PendingStart(pondId: pond.id, project: pond.name, ownerName: pond.ownerName, askedAt: Date())
            note = PondStartRequest.waitingLine(ownerName: pond.ownerName)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(PondStartRequest.lifetime + 1))
                await self?.lapse(id)
            }
            await refresh(pond: pond.id, byPerson: true)
            return true
        } catch let e as NativeHostError { note = e.reason; return false }
        catch { note = "That didn't go through"; return false }
    }

    private func lapse(_ requestId: String) {
        guard let pending = pendingStarts.removeValue(forKey: requestId) else { return }
        note = PondStartRequest.lapsedLine(ownerName: pending.ownerName)
    }

    /// A pond read that carries a thread started for one of this Mac's requests opens it, once.
    private func openRequested(in detail: PondDetail) {
        for (id, pending) in pendingStarts where pending.pondId == detail.pond.id {
            guard let thread = PondStartRequest.thread(for: id, in: detail.threads) else { continue }
            pendingStarts[id] = nil
            if note == PondStartRequest.waitingLine(ownerName: pending.ownerName) { note = nil }
            route = .thread(project: pending.project, pondId: pending.pondId, threadId: thread.id)
        }
    }
}
