import Foundation

/// Any JSON value, for what a film command carries that has no fixed shape: a brief's fields, a styleframe
/// comment, a redo. Numbers keep their kind (a length is a number, never a string).
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else if let o = try? c.decode([String: JSONValue].self) { self = .object(o) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .number(n):
            // A whole number goes out as an integer (60, not 60.0), so the Mac reads the same number.
            if n.rounded() == n, abs(n) < 1e15 { try c.encode(Int64(n)) } else { try c.encode(n) }
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    public var string: String? { if case let .string(s) = self { return s }; return nil }
    public var number: Double? { if case let .number(n) = self { return n }; return nil }
    public var bool: Bool? { if case let .bool(b) = self { return b }; return nil }

    /// An existing workflow answer's value, in this form.
    public init(_ value: WorkflowCommand.Value?) {
        guard let value, let data = try? JSONEncoder().encode(value),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data) else { self = .null; return }
        self = decoded
    }
}

/// The brief call's editable form, as the Mac reads it from the film (RasanAI contract v2). Every part is read
/// as it comes: a field kind or a missing list from a newer or older Mac never fails the whole snapshot.
extension Workflow {
    public struct Brief: Codable, Equatable, Sendable {
        public struct Field: Codable, Equatable, Sendable, Identifiable {
            public struct Option: Codable, Equatable, Sendable, Identifiable {
                public let id: String
                public let label: String
                public init(id: String, label: String) { self.id = id; self.label = label }
            }
            public let key: String
            public let label: String
            /// "text", "longtext", "number", "choice" or "bool"; anything else reads as text.
            public let kind: String
            public var value: JSONValue?
            public var options: [Option]?
            public var min: Double?
            public var max: Double?
            public var id: String { key }
            public init(key: String, label: String, kind: String, value: JSONValue? = nil, options: [Option]? = nil,
                        min: Double? = nil, max: Double? = nil) {
                self.key = key; self.label = label; self.kind = kind; self.value = value
                self.options = options; self.min = min; self.max = max
            }
            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                key = try c.decode(String.self, forKey: .key)
                label = (try? c.decode(String.self, forKey: .label)) ?? key
                kind = (try? c.decode(String.self, forKey: .kind)) ?? "text"
                value = try? c.decode(JSONValue.self, forKey: .value)
                options = try? c.decode([Option].self, forKey: .options)
                min = try? c.decode(Double.self, forKey: .min)
                max = try? c.decode(Double.self, forKey: .max)
            }
        }
        public struct Format: Codable, Equatable, Sendable {
            public let tile: String
            public let option: String
            public let label: String
            public init(tile: String, option: String, label: String) { self.tile = tile; self.option = option; self.label = label }
        }
        public struct FormatTile: Codable, Equatable, Sendable, Identifiable {
            public struct Option: Codable, Equatable, Sendable, Identifiable {
                public let id: String
                public let label: String
                public let lengthS: Double?
                public let aspect: String?
                public init(id: String, label: String, lengthS: Double? = nil, aspect: String? = nil) {
                    self.id = id; self.label = label; self.lengthS = lengthS; self.aspect = aspect
                }
            }
            public let tile: String
            public let title: String
            public let options: [Option]
            public var id: String { tile }
            public init(tile: String, title: String, options: [Option]) { self.tile = tile; self.title = title; self.options = options }
            public init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                tile = try c.decode(String.self, forKey: .tile)
                title = (try? c.decode(String.self, forKey: .title)) ?? tile
                options = (try? c.decode([Option].self, forKey: .options)) ?? []
            }
        }
        public struct Finding: Codable, Equatable, Sendable {
            public let text: String
            public let source: String?
            public init(text: String, source: String? = nil) { self.text = text; self.source = source }
        }
        public struct Capture: Codable, Equatable, Sendable {
            /// An image source, fetched with an image command naming the film.
            public let image: String
            public let caption: String?
            public init(image: String, caption: String? = nil) { self.image = image; self.caption = caption }
        }
        public var fields: [Field]
        public var format: Format?
        public var formats: [FormatTile]
        public var findings: [Finding]
        public var captures: [Capture]
        public init(fields: [Field], format: Format? = nil, formats: [FormatTile] = [], findings: [Finding] = [], captures: [Capture] = []) {
            self.fields = fields; self.format = format; self.formats = formats; self.findings = findings; self.captures = captures
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            fields = (try? c.decode([Field].self, forKey: .fields)) ?? []
            format = try? c.decode(Format.self, forKey: .format)
            formats = (try? c.decode([FormatTile].self, forKey: .formats)) ?? []
            findings = (try? c.decode([Finding].self, forKey: .findings)) ?? []
            captures = (try? c.decode([Capture].self, forKey: .captures)) ?? []
        }
    }

    /// The styleframes call: a grid of frames to approve, comment on, or send back for a redo.
    public struct Styleframes: Codable, Equatable, Sendable {
        public struct Frame: Codable, Equatable, Sendable, Identifiable {
            public let id: String
            public let image: String
            public let ref: String?
            public let shot: String?
            public let verdict: String?
            public init(id: String, image: String, ref: String? = nil, shot: String? = nil, verdict: String? = nil) {
                self.id = id; self.image = image; self.ref = ref; self.shot = shot; self.verdict = verdict
            }
        }
        public var frames: [Frame]
        /// The contact sheet of every frame, when the film made one.
        public var sheet: String?
        public init(frames: [Frame], sheet: String? = nil) { self.frames = frames; self.sheet = sheet }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            frames = (try? c.decode([Frame].self, forKey: .frames)) ?? []
            sheet = try? c.decode(String.self, forKey: .sheet)
        }
    }

    /// A question that is a missing-tool ask: the Mac can install the tool for you.
    public struct ToolAsk: Codable, Equatable, Sendable {
        public let tool: String
        public let label: String
        public init(tool: String, label: String) { self.tool = tool; self.label = label }
    }
}

/// A RasanAI film as the Mac lists it, independent of any chat: where its director is, the call waiting on
/// you, your answers not yet read, and the Ask Rasan thread. Lenient: only the id is required.
public struct PhoneFilm: Codable, Equatable, Sendable, Identifiable {
    public struct Director: Codable, Equatable, Sendable {
        /// "running", "frozen", "stopped", "crashed", "finished" or "none"; anything else reads as none.
        public let state: String
        public let since: String?
        public let detail: String?
        public init(state: String, since: String? = nil, detail: String? = nil) { self.state = state; self.since = since; self.detail = detail }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = (try? c.decode(String.self, forKey: .state)) ?? "none"
            since = try? c.decode(String.self, forKey: .since)
            detail = try? c.decode(String.self, forKey: .detail)
        }
    }
    /// One of your answers the director has not read yet.
    public struct Pending: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        public let type: String
        public let said: String
        public let t: String
        public init(id: String, type: String, said: String, t: String) { self.id = id; self.type = type; self.said = said; self.t = t }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            type = (try? c.decode(String.self, forKey: .type)) ?? ""
            said = (try? c.decode(String.self, forKey: .said)) ?? ""
            t = (try? c.decode(String.self, forKey: .t)) ?? ""
        }
    }
    /// A line of the Ask Rasan thread.
    public struct ChatLine: Codable, Equatable, Sendable, Identifiable {
        public let id: String
        /// "you" or "rasan"; anything else reads as rasan.
        public let who: String
        public let text: String
        public let t: String?
        /// "sent", "pending" (written, not yet read) or nil.
        public let state: String?
        public init(id: String, who: String, text: String, t: String? = nil, state: String? = nil) {
            self.id = id; self.who = who; self.text = text; self.t = t; self.state = state
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            who = (try? c.decode(String.self, forKey: .who)) ?? "rasan"
            text = (try? c.decode(String.self, forKey: .text)) ?? ""
            t = try? c.decode(String.self, forKey: .t)
            state = try? c.decode(String.self, forKey: .state)
        }
        public var isYou: Bool { who == "you" }
    }

    public let id: String
    public let title: String
    public let updatedAt: String
    public let progress: WorkflowProgress?
    public let director: Director
    /// The waiting call, in the same shape as a chat's card.
    public let card: Workflow?
    public let pending: [Pending]
    public let chat: [ChatLine]
    public let canChat: Bool
    public let canResume: Bool
    public let canStop: Bool
    /// The director's fleet session, when one is active: "Open the director's chat".
    public let sessionKey: String?
    /// An image source for the list, fetched with an image command naming the film.
    public let poster: String?
    /// Why something is unavailable ("Update RasanAI Studio to resume from your phone.").
    public let engineNote: String?

    public init(id: String, title: String, updatedAt: String, progress: WorkflowProgress? = nil,
                director: Director = .init(state: "none"), card: Workflow? = nil, pending: [Pending] = [],
                chat: [ChatLine] = [], canChat: Bool = false, canResume: Bool = false, canStop: Bool = false,
                sessionKey: String? = nil, poster: String? = nil, engineNote: String? = nil) {
        self.id = id; self.title = title; self.updatedAt = updatedAt; self.progress = progress; self.director = director
        self.card = card; self.pending = pending; self.chat = chat; self.canChat = canChat; self.canResume = canResume
        self.canStop = canStop; self.sessionKey = sessionKey; self.poster = poster; self.engineNote = engineNote
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? "Film"
        updatedAt = (try? c.decode(String.self, forKey: .updatedAt)) ?? ""
        progress = try? c.decode(WorkflowProgress.self, forKey: .progress)
        director = (try? c.decode(Director.self, forKey: .director)) ?? Director(state: "none")
        card = try? c.decode(Workflow.self, forKey: .card)
        pending = (try? c.decode([Pending].self, forKey: .pending)) ?? []
        chat = (try? c.decode([ChatLine].self, forKey: .chat)) ?? []
        canChat = (try? c.decode(Bool.self, forKey: .canChat)) ?? false
        canResume = (try? c.decode(Bool.self, forKey: .canResume)) ?? false
        canStop = (try? c.decode(Bool.self, forKey: .canStop)) ?? false
        sessionKey = try? c.decode(String.self, forKey: .sessionKey)
        poster = try? c.decode(String.self, forKey: .poster)
        engineNote = try? c.decode(String.self, forKey: .engineNote)
    }

    /// The word on the director's chip: "Waiting on you" outranks the director's own state.
    public var stateWord: String {
        if card != nil || progress?.waiting == true, director.state != "finished" { return "Waiting on you" }
        switch director.state {
        case "running": return "Working"
        case "frozen": return "Paused"
        case "stopped": return "Stopped"
        case "crashed": return "Stopped unexpectedly"
        case "finished": return "Finished"
        default: return "Idle"
        }
    }

    /// Whether the film is waiting on you (a call to make).
    public var waitingOnYou: Bool { director.state != "finished" && (card != nil || progress?.waiting == true) }

    /// "Look", "Brief": the call it is on, from the card, else the progress.
    public var currentCall: String? {
        let call = card?.call ?? progress?.call
        guard let call else { return nil }
        return Self.callName(call)
    }

    public static func callName(_ call: String) -> String {
        ["brief": "Brief", "story": "Story", "look": "Look", "styleframes": "Styleframes", "animatic": "Animatic",
         "final": "Final", "ask": "Question"][call] ?? call.capitalized
    }
}

extension PhoneSnapshot {
    /// A film by id.
    public func film(_ id: String) -> PhoneFilm? { films?.first { $0.id == id } }
}

/// The signed command for a film (kind "film"): answer a call, talk to Rasan, wake or stop the director, or
/// install a missing tool. The Mac checks it like a workflow answer: the call as it is on disk, a fresh nonce.
public struct FilmCommand: Codable, Equatable, Sendable {
    public enum Op: String, Codable, Equatable, Sendable {
        case answer, chat, resume, stop, installTool
    }
    public let v: Int
    public let kind: String
    public let filmId: String
    public let op: Op
    /// answer:
    public var step: String? = nil
    public var revision: String? = nil
    public var type: String? = nil
    public var value: JSONValue? = nil
    public var note: String? = nil
    /// chat (at most 2000 characters):
    public var text: String? = nil
    /// installTool:
    public var askId: String? = nil
    public var tool: String? = nil
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

/// What a brief's form sends for "Start": the fields keyed by name (keeping their own types) and the format.
public enum FilmAnswer {
    public static func briefSubmit(fields: [String: JSONValue], format: (tile: String, option: String)?) -> JSONValue {
        var object: [String: JSONValue] = ["fields": .object(fields)]
        if let format { object["format"] = .object(["tile": .string(format.tile), "option": .string(format.option)]) }
        return .object(object)
    }

    /// A comment on one styleframe.
    public static func frameComment(frame: String, text: String) -> JSONValue {
        .object(["frame": .string(frame), "text": .string(text)])
    }

    /// Frames to redo, with a note for the director.
    public static func redo(ids: [String], note: String) -> JSONValue {
        .object(["ids": .array(ids.map { .string($0) }), "note": .string(note)])
    }
}

/// The Ask Rasan thread as the screen shows it: the Mac's lines, then what was typed here that the Mac's view
/// does not show yet. A typed line stays (as "sending", "sent" or "failed") until the Mac's thread has a
/// "you" line with the same words, so a sent message never vanishes and never doubles.
public enum FilmChat {
    public struct Local: Equatable, Sendable, Identifiable {
        public enum State: Equatable, Sendable { case sending, sent, failed(String) }
        public let id: UUID
        public let text: String
        public let at: Date
        public var state: State
        public init(id: UUID = UUID(), text: String, at: Date = Date(), state: State = .sending) {
            self.id = id; self.text = text; self.at = at; self.state = state
        }
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let id: String
        public let isYou: Bool
        public let text: String
        public let t: String?
        /// "Sending…", "Sent, waiting for Rasan to read it", a failure's words; nil for a settled line.
        public let status: String?
        public let failed: Bool
        /// The typed line this row is, so a failed one can be tried again.
        public let local: UUID?
    }

    private static func norm(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    public static func rows(server: [PhoneFilm.ChatLine], local: [Local]) -> [Row] {
        var rows = server.map { line in
            Row(id: line.id, isYou: line.isYou, text: line.text, t: line.t,
                status: line.state == "pending" ? "Sent, waiting for Rasan to read it" : nil, failed: false, local: nil)
        }
        // Each "you" line on the Mac's side settles one typed line with the same words.
        var shown = server.filter(\.isYou).map { norm($0.text) }
        for item in local {
            if let i = shown.firstIndex(of: norm(item.text)) { shown.remove(at: i); continue }
            let status: String, failed: Bool
            switch item.state {
            case .sending: status = "Sending…"; failed = false
            case .sent: status = "Sent, waiting for Rasan to read it"; failed = false
            case let .failed(reason): status = reason; failed = true
            }
            rows.append(Row(id: "local-" + item.id.uuidString, isYou: true, text: item.text, t: nil, status: status, failed: failed, local: item.id))
        }
        return rows
    }

    /// Typed lines the Mac's thread now shows (or that are old enough to trust the Mac's word about), dropped.
    public static func settled(server: [PhoneFilm.ChatLine], local: [Local], now: Date = Date(), keep: TimeInterval = 600) -> [Local] {
        var shown = server.filter(\.isYou).map { norm($0.text) }
        return local.filter { item in
            if let i = shown.firstIndex(of: norm(item.text)) { shown.remove(at: i); return false }
            if case .failed = item.state { return true }
            return now.timeIntervalSince(item.at) < keep
        }
    }
}
