import Foundation

/// A message waiting beside a Squeak chat's running turn: queued behind it, or steered into it and not yet taken in.
/// `GET /sessions/<id>/pending` and the stream's `pending` events carry them.
public struct NativePendingItem: Sendable, Equatable, Decodable, Identifiable {
    public enum State: String, Sendable, Equatable { case queued, steering, sending }

    public var id: String
    public var text: String
    public var state: State
    public var createdAt: Date?
    /// Being edited: the host does not send it.
    public var held: Bool
    /// A steer's row in the transcript: hidden there while the card shows, until the agent takes it in.
    public var seq: Int?
    /// A steer the agent cannot take in yet because a foreground helper agent is running (`waitingFor: "helper"`).
    public var waitingForHelper = false

    enum CodingKeys: String, CodingKey { case id, text, state, createdAt, held, seq, waitingFor }

    public init(id: String, text: String, state: State = .queued, createdAt: Date? = nil, held: Bool = false, seq: Int? = nil, waitingForHelper: Bool = false) {
        self.waitingForHelper = waitingForHelper; self.id = id; self.text = text; self.state = state; self.createdAt = createdAt; self.held = held; self.seq = seq
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = c.lenient(String.self, .text) ?? ""
        state = c.lenient(String.self, .state).flatMap(State.init(rawValue:)) ?? .queued
        createdAt = c.lenient(String.self, .createdAt).flatMap(DaemonDate.parse)
        held = c.lenient(Bool.self, .held) ?? false
        seq = c.lenient(Int.self, .seq)
        waitingForHelper = c.lenient(String.self, .waitingFor) == "helper"
    }

    public init(_ q: NativeQueueItem) { self.init(id: q.id, text: q.text, state: .queued, createdAt: q.createdAt) }
}

/// One `pending` event of the stream.
public enum NativePendingChange: Sendable, Equatable {
    case snapshot([NativePendingItem])
    case add(NativePendingItem)
    case update(NativePendingItem)
    /// `consumed`: the agent took it in (a steer absorbed, a queued message started), as opposed to deleted.
    case remove(id: String, consumed: Bool, seq: Int?)
}

/// The queue stack above the composer, built from the host's pending items and the Mac's own just-sent ones.
/// Newest last. A steer's transcript row stays out of the transcript while its card is here, and appears there
/// (full opacity) the moment the host says it was consumed.
public struct NativePendingStack: Sendable, Equatable {
    public struct Local: Sendable, Equatable, Identifiable {
        public var id: String
        public var text: String
        public var steer: Bool
        public var at: Date
        /// The send was accepted as a queue entry (`queued`): kept until the host's own item replaces it.
        public var settled = false
    }

    public private(set) var host: [NativePendingItem] = []
    public private(set) var locals: [Local] = []
    /// Steered messages the host reported consumed since this chat opened: their rows are plain transcript now.
    public private(set) var consumedSeqs: Set<Int> = []

    public init() {}

    /// How long an accepted queue send may wait for the host's item before the card goes.
    public static let settleGrace: TimeInterval = 5

    public mutating func apply(_ change: NativePendingChange, now: Date = Date()) {
        defer { prune(now: now) }
        switch change {
        case .snapshot(let items):
            host = Self.sorted(items)
            dropMatchedLocals()
        case .add(let item), .update(let item):
            if let i = host.firstIndex(where: { $0.id == item.id }) { host[i] = item } else { host.append(item) }
            host = Self.sorted(host)
            dropMatchedLocals()
        case .remove(let id, let consumed, let seq):
            host.removeAll { $0.id == id }
            if consumed, let seq { consumedSeqs.insert(seq) }
        }
    }

    /// A message just sent while the agent works: a card now, before the host has answered.
    public mutating func beginLocal(id: String, text: String, steer: Bool, at: Date) {
        locals.append(Local(id: id, text: text, steer: steer, at: at))
    }

    /// The send's answer: a failure removes the card (the words go back to the draft); a message the host took in at
    /// once (a steer with no card of its own) removes it too; a queued one waits for the host's item.
    public mutating func settleLocal(id: String, accepted: Bool, queued: Bool) {
        guard let i = locals.firstIndex(where: { $0.id == id }) else { return }
        // The host queued it behind the turn (Claude cannot take a steer mid-turn): it is no longer a steer, so the card
        // must not say "Steering…" while it waits for the host's own item.
        if accepted && queued { locals[i].settled = true; locals[i].steer = false } else { locals.remove(at: i) }
    }

    /// A settled local card past its grace (the ticker prunes only then, so an idle chat redraws nothing).
    public func hasStale(now: Date) -> Bool {
        locals.contains { $0.settled && now.timeIntervalSince($0.at) > Self.settleGrace }
    }

    public mutating func prune(now: Date) {
        locals.removeAll { $0.settled && now.timeIntervalSince($0.at) > Self.settleGrace }
    }

    public mutating func reset() { self = NativePendingStack() }

    /// What the stack draws, oldest first so the newest is last.
    public var cards: [Card] {
        host.map { Card(id: $0.id, text: $0.text, kind: Card.kind(of: $0), held: $0.held, isLocal: false, waitingForHelper: $0.waitingForHelper) }
            + locals.map { Card(id: $0.id, text: $0.text, kind: $0.steer ? .steering : .sending, held: false, isLocal: true) }
    }

    /// The cards that stay in the queue stack above the composer: queued follow-ups and sends going out.
    public var stackCards: [Card] { cards.filter { $0.kind != .steering } }

    /// Steers waiting to be taken in: drawn dimmed at the bottom of the stream, and solid in place once consumed.
    public var inlineSteers: [Card] { cards.filter { $0.kind == .steering } }

    /// A steer is waiting: the running turn's chain is not over, so nothing folds yet.
    public var hasSteer: Bool { !inlineSteers.isEmpty }

    public struct Card: Sendable, Equatable, Identifiable {
        public enum Kind: Sendable, Equatable { case queued, steering, sending }
        public var id: String
        public var text: String
        public var kind: Kind
        public var held: Bool
        public var isLocal: Bool
        public var waitingForHelper = false

        /// The words beside a steer card's glyph; nil for a card that says nothing.
        public var label: String? {
            guard kind == .steering else { return nil }
            return waitingForHelper ? "Waiting for helper…" : "Steering…"
        }

        static func kind(of item: NativePendingItem) -> Kind {
            switch item.state {
            case .queued: .queued
            case .steering: .steering
            case .sending: .sending
            }
        }
    }

    /// The transcript row (`native-<seq>`) of a steer whose card is up: not drawn yet.
    public func hides(messageId: String) -> Bool {
        guard messageId.hasPrefix(NativePendingStack.rowPrefix), let seq = Int(messageId.dropFirst(NativePendingStack.rowPrefix.count)) else {
            return false
        }
        return host.contains { $0.state == .steering && $0.seq == seq }
    }

    public static let rowPrefix = "native-"

    /// The transcript without the steers still waiting to be taken in.
    public func visible(_ messages: [ChatMessage]) -> [ChatMessage] {
        guard host.contains(where: { $0.state == .steering && $0.seq != nil }) else { return messages }
        return messages.filter { !hides(messageId: $0.id) }
    }

    // MARK: Internals

    /// Oldest first; equal times keep the order they came in.
    private static func sorted(_ items: [NativePendingItem]) -> [NativePendingItem] {
        items.enumerated().sorted { a, b in
            let ta = a.element.createdAt ?? .distantFuture, tb = b.element.createdAt ?? .distantFuture
            return ta == tb ? a.offset < b.offset : ta < tb
        }.map(\.element)
    }

    /// A card the host now lists for itself (same words, oldest first) is no longer drawn twice.
    private mutating func dropMatchedLocals() {
        var unmatched = host
        locals.removeAll { l in
            guard let i = unmatched.firstIndex(where: { $0.text == l.text }) else { return false }
            unmatched.remove(at: i)
            return true
        }
    }
}

public extension NativeEvent {
    /// The change a `pending` frame carries; nil for any other event.
    var pendingChange: NativePendingChange? {
        if case .pending(let c) = self { c } else { nil }
    }
}
