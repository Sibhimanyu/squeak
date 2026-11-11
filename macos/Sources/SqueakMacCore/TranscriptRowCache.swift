import Foundation

/// What the transcript's rows are built from, kept between body passes. The detail view's body runs on every poll and
/// every streamed step, and used to rebuild all of it each time: the turn footers join the text of every message, and
/// the lettered options parse a message's markdown. Both are products of the messages alone, so they are computed once per
/// change. `footerBuilds` / `layoutBuilds` let a test prove unchanged messages are not rebuilt.
public final class TranscriptRowCache {
    public private(set) var footerBuilds = 0
    public private(set) var layoutBuilds = 0

    private struct FooterKey: Equatable {
        var count: Int
        var first: String?
        var last: String?
        var lastTextBytes: Int
        var lastAt: Date?
        var working: Bool
    }
    private var footerKey: FooterKey?
    private var footerCached: [String: TurnFooter] = [:]

    private struct LayoutEntry { var textHash: Int; var layout: ChoiceLayout? }
    private var layouts: [String: LayoutEntry] = [:]

    public init() {}

    /// `TurnFooters.make`, rebuilt only when the message list or the turn state moved (a streamed delta lands in the
    /// last message, so its length is in the key).
    public func footers(_ messages: [ChatMessage], working: Bool) -> [String: TurnFooter] {
        let key = FooterKey(
            count: messages.count, first: messages.first?.id, last: messages.last?.id,
            lastTextBytes: messages.last?.text.utf8.count ?? 0, lastAt: messages.last?.at, working: working)
        if key == footerKey { return footerCached }
        footerBuilds += 1
        footerKey = key
        footerCached = TurnFooters.make(messages, working: working)
        return footerCached
    }

    /// `ChoiceLayout.make` for one message, parsed once per (id, text).
    public func choiceLayout(for message: ChatMessage) -> ChoiceLayout? {
        let hash = message.text.hashValue
        if let hit = layouts[message.id], hit.textHash == hash { return hit.layout }
        layoutBuilds += 1
        let layout = ChoiceLayout.make(message.text)
        if layouts.count > 256 { layouts.removeAll(keepingCapacity: true) }
        layouts[message.id] = LayoutEntry(textHash: hash, layout: layout)
        return layout
    }
}
