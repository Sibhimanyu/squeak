#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// What a film's call card belongs to, so its pictures, media and answers go to the right place: a chat's
/// film card (named by the session's key) or a film of its own (named by the film's id).
enum WorkflowOwner {
    case session(PhoneSnapshot.Session)
    case film(PhoneFilm)

    var film: PhoneFilm? { if case let .film(film) = self { film } else { nil } }
}

/// A picture on a film's card, loaded from the Mac when it shows (the card asks you to judge by looking).
/// Tap for full screen, with Share (Save Image, Copy, AirDrop).
struct CardPicture: View {
    enum Fit {
        /// As wide as the space, this tall.
        case fill(height: CGFloat)
        case box(width: CGFloat, height: CGFloat)
        /// As wide as the space, at this width over height.
        case ratio(CGFloat)
    }

    @Environment(AppModel.self) private var model
    let owner: WorkflowOwner
    let source: String
    let name: String
    var fit: Fit = .fill(height: 200)
    var radius: CGFloat = 10
    var tappable = true

    private enum Phase { case loading, loaded(UIImage), failed(String) }
    @State private var phase: Phase = .loading
    @State private var viewing = false
    @State private var attempt = 0

    var body: some View {
        content
            .task(id: "\(source)#\(attempt)") {
                phase = .loading
                switch await model.loadImage(owner, source: source) {
                case let .image(image): phase = .loaded(image)
                case let .refused(reason): phase = .failed(reason)
                }
            }
    }

    @ViewBuilder private var content: some View {
        switch phase {
        case let .loaded(image):
            let picture = sized(Image(uiImage: image).resizable().scaledToFill())
                .clipShape(RoundedRectangle(cornerRadius: radius))
                .overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.line, lineWidth: 0.5))
                .contentShape(RoundedRectangle(cornerRadius: radius))
            if tappable {
                Button { Haptics.play(.tap); viewing = true } label: { picture }
                    .buttonStyle(.press)
                    .accessibilityLabel(name)
                    .accessibilityHint("Opens the image full screen")
                    .fullScreenCover(isPresented: $viewing) { ImageViewer(images: [image], title: name) }
            } else {
                picture.accessibilityLabel(name)
            }
        case .loading:
            placeholder { GlyphLoader() }
        case let .failed(reason):
            Button { attempt += 1 } label: {
                placeholder {
                    if case .box = fit { Lucide(.eyeOff, size: 14, color: Theme.subtle) }
                    else {
                        VStack(spacing: 4) {
                            Text(reason).font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                            Text("Tap to try again").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink)
                        }.padding(8)
                    }
                }
            }
            .buttonStyle(.press)
            .accessibilityLabel("\(name), couldn't load")
            .accessibilityHint("Tries again")
        }
    }

    @ViewBuilder private func sized(_ view: some View) -> some View {
        switch fit {
        case let .fill(height): view.frame(maxWidth: .infinity).frame(height: height)
        case let .box(width, height): view.frame(width: width, height: height)
        case let .ratio(ratio): Color.clear.aspectRatio(ratio, contentMode: .fit).overlay(view).frame(maxWidth: .infinity)
        }
    }

    private func placeholder(@ViewBuilder _ inner: () -> some View) -> some View {
        sized(Theme.surfaceRaised.overlay(inner()))
            .clipShape(RoundedRectangle(cornerRadius: radius))
            .accessibilityLabel(name)
    }
}

/// The director's state as a dot and a word (DESIGN.md §8.1): words carry it, the colour only echoes.
struct FilmStateMark: View {
    let film: PhoneFilm

    static func color(_ film: PhoneFilm) -> Color {
        if film.waitingOnYou { return Theme.needsYou }
        switch film.director.state {
        case "running": return Theme.working
        case "finished": return Theme.done
        case "crashed": return Theme.error
        default: return Theme.subtle
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            StatusDot(color: Self.color(film), pulses: film.director.state == "running" && !film.waitingOnYou)
            Text(film.stateWord).font(.footnote.weight(film.waitingOnYou ? .semibold : .regular))
                .foregroundStyle(film.waitingOnYou ? Theme.ink : Theme.muted)
        }
        .accessibilityElement(children: .combine)
    }
}

/* ---------- Home: the Films section ---------- */

/* ---------- Needs you: a film waiting on a call ---------- */

/// A film that needs you, as a card on the Needs you page: its call in words and a way into it.
struct FilmDecisionCard: View {
    let film: PhoneFilm
    var prominent = false
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(["RasanAI", film.title].joined(separator: " · ").uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                Spacer(minLength: 4)
                Text(Age.describe(film.updatedAt)).font(.footnote).foregroundStyle(Theme.muted).monospacedDigit()
            }
            Text(film.card?.ask?.question ?? film.card?.prompt ?? "Waiting on you")
                .font(prominent ? .title2.weight(.semibold) : .title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let context = film.card?.context ?? film.card?.ask?.context, !context.isEmpty {
                Text(context).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(3)
            }
            if let poster = film.poster, prominent {
                CardPicture(owner: .film(film), source: poster, name: "Poster of \(film.title)", fit: .ratio(16.0 / 9.0), tappable: false)
            }
            Button(action: { Haptics.play(.tap); onOpen() }) {
                Text("Open the call").font(.body.weight(.semibold))
            }
            .buttonStyle(PrimaryButtonStyle())
        }
        .padding(prominent ? 20 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
        .accessibilityElement(children: .contain)
    }
}

/* ---------- the film screen ---------- */

struct FilmView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    let id: String

    var body: some View {
        Group {
            if let film = model.film(id) {
                FilmScreen(film: film)
            } else {
                ContentUnavailableView("This film isn't listed any more", systemImage: "film",
                                       description: Text("Your Mac lists films from the last week."))
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(model.film(id)?.title ?? "Film")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { screen.report?("Film") }
    }
}

private struct FilmScreen: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let film: PhoneFilm
    @State private var confirmingStop = false
    @State private var busy = false
    @State private var line: (delivered: Bool, text: String)?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    header
                    if let progress = film.progress { FilmProgressCard(progress: progress) }
                    if let card = film.card { callCard(card) }
                    if !film.pending.isEmpty { pending }
                    FilmChatCard(film: film).id("chat")
                    if let key = film.sessionKey, model.snapshot?.session(key) != nil {
                        NavigationLink(value: HomeRoute.session(key)) {
                            HStack {
                                Text("Open the director's chat").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                                Spacer(minLength: 8)
                                Lucide(.chevronRight, size: 16, color: Theme.subtle)
                            }
                            .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                            .contentShape(RoundedRectangle(cornerRadius: 12))
                        }.tapHaptic(.navigate)
                        .buttonStyle(.press)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { Haptics.play(.refresh); await model.refresh() }
            .onAppear {
                // `-squeak-film-scroll chat`: scroll to the Ask Rasan thread, for screenshots of the demo.
                let args = ProcessInfo.processInfo.arguments
                if let i = args.firstIndex(of: "-squeak-film-scroll"), i + 1 < args.count {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) { proxy.scrollTo(args[i + 1], anchor: .top) }
                }
            }
        }
        .foregroundStyle(Theme.ink)
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .confirmationDialog("Stop \(film.title)?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop the director", role: .destructive) { run(resume: false) }
            Button("Keep it running", role: .cancel) {}
        } message: {
            Text("The film stays as it is. You can resume it from here later.")
        }
    }

    /* header */

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(film.title).font(.title2.weight(.bold)).fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            HStack(spacing: 10) {
                FilmStateMark(film: film)
                Text("· updated \(Age.describe(film.updatedAt))").font(.footnote).foregroundStyle(Theme.subtle)
            }
            if let detail = film.director.detail, !detail.isEmpty {
                Text(detail).font(.footnote).foregroundStyle(Theme.muted)
            }
            if film.canResume || film.canStop {
                HStack(spacing: 10) {
                    if film.canResume {
                        Button { Haptics.play(.tap); run(resume: true) } label: {
                            HStack(spacing: 8) {
                                if busy { GlyphLoader(color: Theme.primaryText) } else { Lucide(.play, size: 16, color: Theme.primaryText) }
                                Text(film.director.state == "frozen" ? "Resume" : "Wake the director")
                            }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                    }
                    if film.canStop {
                        Button { Haptics.play(.tap); confirmingStop = true } label: {
                            Text("Stop").font(.body.weight(.semibold)).foregroundStyle(Theme.ink)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
                        }
                        .buttonStyle(.press)
                    }
                }
                .disabled(busy)
            }
            if let line {
                Text(line.text).font(.footnote).foregroundStyle(line.delivered ? Theme.muted : Theme.needsYou)
                if !line.delivered { ReportProblemButton(problem: line.text, place: "Films", title: "Report") }
            }
            if let note = film.engineNote, !note.isEmpty {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
                    Text(note).font(.footnote).foregroundStyle(Theme.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func run(resume: Bool) {
        busy = true
        line = nil
        Task {
            let outcome = await model.filmDirector(film, resume: resume)
            busy = false
            if !outcome.line.isEmpty { line = (outcome.delivered, outcome.line) }
        }
    }

    /* the waiting call */

    @ViewBuilder private func callCard(_ workflow: Workflow) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if workflow.brief != nil, workflow.macOnly == nil {
                BriefCard(film: film, workflow: workflow).id(workflow.revision)
            } else if workflow.styleframes != nil, workflow.macOnly == nil {
                StyleframesCard(film: film, workflow: workflow).id(workflow.revision)
            } else {
                WorkflowCard(workflow: workflow, owner: .film(film))
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private var pending: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SENT, WAITING FOR RASAN TO READ").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            ForEach(film.pending) { item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Lucide(.clock, size: 14, color: Theme.muted).accessibilityHidden(true)
                    Text(item.said.isEmpty ? item.type : item.said).font(.subheadline).foregroundStyle(Theme.ink)
                    Spacer(minLength: 4)
                    if !item.t.isEmpty { Text(Age.describe(item.t)).font(.footnote).foregroundStyle(Theme.muted).monospacedDigit() }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }
}

/* ---------- shared bits for the call cards ---------- */

/// The call's title and prompt, in the same voice as WorkflowCard's header.
private struct CallHeader: View {
    let workflow: Workflow
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(["RasanAI", workflow.title].compactMap { $0 }.joined(separator: " · ").uppercased())
                .font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            Text(workflow.prompt).font(.headline)
            if let context = workflow.context, !context.isEmpty {
                Text(context).font(.subheadline).foregroundStyle(Theme.muted)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private struct FilmSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .foregroundStyle(isEnabled ? Theme.ink : Theme.subtle)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.lineStrong))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

private func resultLine(_ result: (delivered: Bool, line: String)?) -> some View {
    Group {
        if let result {
            Text(result.line).font(.footnote).foregroundStyle(result.delivered ? Theme.muted : Theme.needsYou)
            if !result.delivered { ReportProblemButton(problem: result.line, place: "Films › Answer", title: "Report") }
        } else {
            Text("Goes to RasanAI on your Mac, the same as answering in RasanAI Studio.").font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

/* ---------- the brief ---------- */

/// The brief, as a form: every field by its kind, the format to pick, what the research found and the pages it
/// looked at. "Start" sends the form (numbers stay numbers); "Just make it" lets Rasan decide the rest.
struct BriefCard: View {
    @Environment(AppModel.self) private var model
    let film: PhoneFilm
    let workflow: Workflow

    @State private var texts: [String: String] = [:]
    @State private var picks: [String: JSONValue] = [:]
    @State private var format: (tile: String, option: String)?
    @State private var seeded = false
    @State private var sending = false
    @State private var result: (delivered: Bool, line: String)?
    @State private var findingsOpen = false

    private var brief: Workflow.Brief { workflow.brief ?? .init(fields: []) }
    private var answered: Bool { result?.delivered == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CallHeader(workflow: workflow)
            if !brief.captures.isEmpty { captures }
            if !brief.findings.isEmpty { findings }
            VStack(alignment: .leading, spacing: 12) {
                ForEach(brief.fields) { field in fieldRow(field) }
            }
            if !brief.formats.isEmpty { formatPicker }
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(sending || answered)
        .onAppear(perform: seed)
    }

    private func seed() {
        guard !seeded else { return }
        seeded = true
        for field in brief.fields {
            switch field.kind {
            case "choice", "bool": picks[field.key] = field.value ?? .null
            default: texts[field.key] = Self.text(of: field.value)
            }
        }
        if let f = brief.format { format = (f.tile, f.option) }
    }

    private static func text(of value: JSONValue?) -> String {
        switch value {
        case let .string(s): return s
        case let .number(n): return n.rounded() == n ? String(Int64(n)) : String(n)
        case let .bool(b): return b ? "true" : "false"
        default: return ""
        }
    }

    /* pictures and findings */

    private var captures: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("WHAT I LOOKED AT").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(Array(brief.captures.enumerated()), id: \.offset) { _, capture in
                        VStack(alignment: .leading, spacing: 4) {
                            CardPicture(owner: .film(film), source: capture.image, name: capture.caption ?? "Capture", fit: .box(width: 176, height: 110))
                            if let caption = capture.caption, !caption.isEmpty {
                                Text(caption).font(.caption).foregroundStyle(Theme.muted).lineLimit(1).frame(width: 176, alignment: .leading)
                            }
                        }
                    }
                }
            }
        }
    }

    private var findings: some View {
        DisclosureGroup(isExpanded: $findingsOpen) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(brief.findings.prefix(8).enumerated()), id: \.offset) { _, finding in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(finding.text).font(.subheadline).foregroundStyle(Theme.ink)
                        if let source = finding.source, !source.isEmpty { Text(source).font(.caption).foregroundStyle(Theme.muted) }
                    }
                }
            }
            .padding(.top, 6).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Text("What I found (\(min(brief.findings.count, 8)))").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
        }
        .tint(Theme.muted)
    }

    /* fields */

    private func fieldRow(_ field: Workflow.Brief.Field) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(field.label).font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
            switch field.kind {
            case "bool":
                Toggle(isOn: (Binding(get: { picks[field.key]?.bool ?? false }, set: { picks[field.key] = .bool($0) })).haptic(.toggle)) {
                    Text(picks[field.key]?.bool == true ? "Yes" : "No").font(.body).foregroundStyle(Theme.ink)
                }
                .tint(Theme.info)
                .padding(.horizontal, 14).frame(minHeight: 44)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            case "choice":
                choice(field)
            case "number":
                TextField("", text: Binding(get: { texts[field.key] ?? "" }, set: { texts[field.key] = $0 }))
                    .keyboardType(.decimalPad)
                    .modifier(FieldBox())
                if let problem = numberProblem(field) {
                    Text(problem).font(.caption).foregroundStyle(Theme.needsYou)
                } else if let min = field.min, let max = field.max {
                    Text("\(Int(min)) to \(Int(max))").font(.caption).foregroundStyle(Theme.subtle)
                }
            case "longtext":
                TextField("", text: Binding(get: { texts[field.key] ?? "" }, set: { texts[field.key] = $0 }), axis: .vertical)
                    .lineLimit(2...8)
                    .modifier(FieldBox())
            default:
                TextField("", text: Binding(get: { texts[field.key] ?? "" }, set: { texts[field.key] = $0 }))
                    .modifier(FieldBox())
            }
        }
    }

    @ViewBuilder private func choice(_ field: Workflow.Brief.Field) -> some View {
        let options = field.options ?? []
        let current = picks[field.key]?.string
        if options.count <= 4 {
            HStack(spacing: 8) {
                ForEach(options) { option in
                    let on = current == option.id
                    Button { picks[field.key] = .string(option.id); Haptics.play(.option) } label: {
                        Text(option.label).font(.subheadline.weight(on ? .semibold : .regular)).foregroundStyle(Theme.ink)
                            .multilineTextAlignment(.center).frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 6)
                            .background(on ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 1.5 : 1))
                    }
                    .buttonStyle(.press)
                    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
                }
            }
        } else {
            Picker(field.label, selection: (Binding(get: { current ?? "" }, set: { picks[field.key] = .string($0) })).haptic(.pick)) {
                ForEach(options) { Text($0.label).tag($0.id) }
            }
            .pickerStyle(.menu).tint(Theme.ink)
            .frame(maxWidth: .infinity, alignment: .leading).modifier(FieldBox())
        }
    }

    private func numberProblem(_ field: Workflow.Brief.Field) -> String? {
        let raw = (texts[field.key] ?? "").trimmingCharacters(in: .whitespaces)
        guard let n = Double(raw) else { return raw.isEmpty ? "Enter a number." : "That isn't a number." }
        if let min = field.min, n < min { return "At least \(Int(min))." }
        if let max = field.max, n > max { return "At most \(Int(max))." }
        return nil
    }

    /* format */

    private var formatPicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FORMAT").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
            ForEach(brief.formats) { tile in
                VStack(alignment: .leading, spacing: 6) {
                    Text(tile.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    ForEach(tile.options) { option in
                        let on = format?.tile == tile.tile && format?.option == option.id
                        Button { format = (tile.tile, option.id); Haptics.play(.option) } label: {
                            HStack(spacing: 10) {
                                Lucide(on ? .circleCheck : .circle, size: 18, color: on ? Theme.ink : Theme.subtle).accessibilityHidden(true)
                                Text(option.label).font(.body).foregroundStyle(Theme.ink)
                                Spacer(minLength: 4)
                                Text(meta(option)).font(.footnote).foregroundStyle(Theme.muted).monospacedDigit()
                            }
                            .padding(.horizontal, 14).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .background(on ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 1.5 : 1))
                            .contentShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.press)
                        .accessibilityLabel("\(tile.title), \(option.label), \(meta(option))")
                        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
                    }
                }
            }
        }
    }

    private func meta(_ option: Workflow.Brief.FormatTile.Option) -> String {
        [option.lengthS.map { "\(Int($0)) s" }, option.aspect].compactMap { $0 }.joined(separator: " · ")
    }

    /* send */

    private var valid: Bool {
        !brief.fields.contains { $0.kind == "number" && numberProblem($0) != nil }
    }

    private func submission() -> JSONValue {
        var fields: [String: JSONValue] = [:]
        for field in brief.fields {
            switch field.kind {
            case "bool": if let v = picks[field.key], v != .null { fields[field.key] = v }
            case "choice": if let v = picks[field.key], v != .null { fields[field.key] = v }
            case "number":
                if let n = Double((texts[field.key] ?? "").trimmingCharacters(in: .whitespaces)) { fields[field.key] = .number(n) }
            default:
                // Unknown kinds pass through as text, like the Mac's own.
                fields[field.key] = .string(texts[field.key] ?? "")
            }
        }
        return FilmAnswer.briefSubmit(fields: fields, format: format)
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !answered {
                if let macOnly = workflow.macOnly {
                    Text(macOnly).font(.footnote).foregroundStyle(Theme.muted)
                } else {
                    Button { send("submit", submission()) } label: {
                        HStack(spacing: 8) {
                            if sending { GlyphLoader(color: Theme.primaryText) }
                            Text(sending ? "Sending…" : "Start")
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!valid)
                    Button { send("decide-rest", nil) } label: { Text("Just make it") }
                        .buttonStyle(FilmSecondaryButtonStyle())
                    Text("\"Just make it\" lets Rasan decide everything you left as it is.").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            resultLine(result)
        }
    }

    private func send(_ type: String, _ value: JSONValue?) {
        sending = true
        Task {
            let outcome = await model.act(on: film, workflow: workflow, type: type, value: value)
            sending = false
            if !outcome.line.isEmpty { result = outcome }
        }
    }
}

private struct FieldBox: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.body).foregroundStyle(Theme.ink)
            .padding(.horizontal, 14).padding(.vertical, 11).frame(minHeight: 44)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }
}

/* ---------- styleframes ---------- */

/// The styleframes grid: tap a frame for it full screen (swipe through the rest), mark frames to send back,
/// comment on one, or approve them all.
struct StyleframesCard: View {
    @Environment(AppModel.self) private var model
    let film: PhoneFilm
    let workflow: Workflow

    @State private var marked: Set<String> = []
    @State private var commenting: String?
    @State private var words = ""
    @State private var sending = false
    @State private var result: (delivered: Bool, line: String)?
    @State private var viewer: Int?

    private var frames: [Workflow.Styleframes.Frame] { workflow.styleframes?.frames ?? [] }
    private var answered: Bool { result?.delivered == true && result?.line.hasPrefix("Commented") != true }

    private let columns = [GridItem(.flexible(), spacing: 10, alignment: .top), GridItem(.flexible(), spacing: 10, alignment: .top)]

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            CallHeader(workflow: workflow)
            if let sheet = workflow.styleframes?.sheet {
                CardPicture(owner: .film(film), source: sheet, name: "Every frame on one sheet", fit: .ratio(16.0 / 9.0))
            }
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(frames) { frame in cell(frame) }
            }
            .id("grid")
            composer
            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(sending || answered)
        .fullScreenCover(item: Binding(get: { viewer.map(Index.init) }, set: { viewer = $0?.value })) { index in
            FramesViewer(film: film, frames: frames, start: index.value)
        }
    }

    private struct Index: Identifiable { let value: Int; var id: Int { value } }

    private func cell(_ frame: Workflow.Styleframes.Frame) -> some View {
        let on = marked.contains(frame.id)
        return VStack(alignment: .leading, spacing: 6) {
            ZStack(alignment: .topTrailing) {
                // A real button, so the frame dims on the touch like every other tap while the viewer opens.
                Button { Haptics.play(.tap); viewer = frames.firstIndex(of: frame) } label: {
                    CardPicture(owner: .film(film), source: frame.image, name: frame.shot ?? "Frame \(frame.id)", fit: .ratio(16.0 / 9.0), radius: 8, tappable: false)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(on ? Theme.ink : Color.clear, lineWidth: 2))
                }
                .buttonStyle(.press)
                .accessibilityHint("Opens the frame full screen")
                Button {
                    if on { marked.remove(frame.id) } else { marked.insert(frame.id) }
                    Haptics.play(.option)
                } label: {
                    Lucide(on ? .circleCheck : .circle, size: 20, color: on ? Theme.ink : Color.white)
                        .padding(5).background(on ? Theme.primaryFill : Color.black.opacity(0.45), in: Circle())
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.press)
                .accessibilityLabel(on ? "Frame \(frame.id) marked to redo" : "Mark frame \(frame.id) to redo")
                .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
            }
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(frame.shot ?? "Frame \(frame.id)").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 2)
                Button { Haptics.play(.tap); commenting = frame.id } label: {
                    Text("Comment").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
                .buttonStyle(.press)
                .accessibilityLabel("Comment on \(frame.shot ?? "frame \(frame.id)")")
            }
            if let verdict = frame.verdict, !verdict.isEmpty {
                Text(verdict).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
            }
            if let ref = frame.ref {
                HStack(spacing: 6) {
                    CardPicture(owner: .film(film), source: ref, name: "Reference for \(frame.shot ?? frame.id)", fit: .box(width: 40, height: 26), radius: 4)
                    Text("Reference").font(.caption).foregroundStyle(Theme.subtle)
                }
            }
        }
    }

    @ViewBuilder private var composer: some View {
        if let id = commenting, let frame = frames.first(where: { $0.id == id }) {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Comment on \(frame.shot ?? "frame \(frame.id)")").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                    Spacer(minLength: 4)
                    Button { Haptics.play(.tap); commenting = nil; words = "" } label: { Lucide(.x, size: 16, label: "Cancel comment", color: Theme.muted).frame(width: 44, height: 44) }
                        .buttonStyle(.press)
                }
                TextField("What should change in this frame?", text: $words, axis: .vertical).lineLimit(1...5).modifier(FieldBox())
                Button { Haptics.play(.tap); sendComment(frame) } label: { Text("Send comment") }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        } else if !marked.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("What should change in the \(marked.count) marked frame\(marked.count == 1 ? "" : "s")?").font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
                TextField("Optional note for Rasan", text: $words, axis: .vertical).lineLimit(1...5).modifier(FieldBox())
            }
        }
    }

    private var actions: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !answered {
                Button { send("approve", nil) } label: {
                    HStack(spacing: 8) {
                        if sending { GlyphLoader(color: Theme.primaryText) }
                        Text(sending ? "Sending…" : "Approve the frames")
                    }
                }
                .buttonStyle(PrimaryButtonStyle())
                if !marked.isEmpty {
                    Button {
                        let ids = frames.map(\.id).filter(marked.contains)
                        send("redo", FilmAnswer.redo(ids: ids, note: words.trimmingCharacters(in: .whitespacesAndNewlines)))
                    } label: { Text("Redo \(marked.count) marked") }
                        .buttonStyle(FilmSecondaryButtonStyle())
                }
                if workflow.canDecide == true {
                    Button { send("decide", nil) } label: { Text("You decide") }
                        .buttonStyle(FilmSecondaryButtonStyle())
                }
            }
            resultLine(result)
        }
    }

    private func send(_ type: String, _ value: JSONValue?) {
        sending = true
        Task {
            let outcome = await model.act(on: film, workflow: workflow, type: type, value: value)
            sending = false
            if !outcome.line.isEmpty { result = outcome }
        }
    }

    private func sendComment(_ frame: Workflow.Styleframes.Frame) {
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        sending = true
        Task {
            let outcome = await model.act(on: film, workflow: workflow, type: "comment", value: FilmAnswer.frameComment(frame: frame.id, text: text))
            sending = false
            if outcome.delivered {
                result = (true, "Commented on \(frame.shot ?? "frame \(frame.id)"). Rasan reads it with the rest.")
                commenting = nil; words = ""
            } else if !outcome.line.isEmpty {
                result = outcome
            }
        }
    }
}

/// Every frame full screen, swipeable: opens at the one tapped at once, and each frame fills in as it lands
/// (the tapped one first, then the rest, three at a time). A frame that failed says so and loads again on a tap.
private struct FramesViewer: View {
    @Environment(AppModel.self) private var model
    let film: PhoneFilm
    let frames: [Workflow.Styleframes.Frame]
    let start: Int
    @State private var pages: [Int: ImageViewer.Page] = [:]
    @State private var loader = FrameLoader()

    var body: some View {
        ImageViewer(pages: frames.indices.map { page($0) }, index: min(max(start, 0), max(frames.count - 1, 0)),
                    title: frames.indices.contains(start) ? (frames[start].shot ?? "Frame") : "Frame")
            .task { await loadAll() }
    }

    private func page(_ i: Int) -> ImageViewer.Page {
        pages[i] ?? .loading
    }

    /// Tapped frame first, then outward; three loads at a time.
    private func loadAll() async {
        let order = frames.indices.sorted { abs($0 - start) < abs($1 - start) }
        for i in order { pages[i] = .loading }
        await withTaskGroup(of: Void.self) { group in
            for i in order {
                group.addTask { await load(i) }
            }
        }
    }

    private func load(_ i: Int) async {
        await loader.limiter.run {
            let answer = await model.loadImage(film: film, source: frames[i].image)
            await MainActor.run {
                switch answer {
                case let .image(image): pages[i] = .image(image)
                case let .refused(reason): pages[i] = .failed(reason) { retry(i) }
                }
            }
        }
    }

    private func retry(_ i: Int) {
        pages[i] = .loading
        Task { await load(i) }
    }
}

private final class FrameLoader: @unchecked Sendable {
    let limiter = ConcurrencyLimiter(limit: 3)
}

/* ---------- Ask Rasan ---------- */

/// The thread with Rasan (the director) about this film: its words, yours, a composer. A line you just sent
/// shows at once and says where it is until the Mac's thread has it.
struct FilmChatCard: View {
    @Environment(AppModel.self) private var model
    let film: PhoneFilm
    @State private var draft = ""
    @FocusState private var focused: Bool

    private var rows: [FilmChat.Row] { model.filmChatRows(film) }

    private var reason: String? {
        if film.canChat { return nil }
        if let note = film.engineNote, !note.isEmpty { return note }
        return film.director.state == "finished" ? "The film is finished, so there is no one to ask." : "Asking Rasan isn't available for this film."
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("ASK RASAN").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted).accessibilityAddTraits(.isHeader)
            if rows.isEmpty {
                Text("Ask why it chose something, or tell it what to change. It answers in a few sentences.")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            } else {
                VStack(spacing: 10) { ForEach(rows) { bubble($0) } }
            }
            composer
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
    }

    private func bubble(_ row: FilmChat.Row) -> some View {
        VStack(alignment: row.isYou ? .trailing : .leading, spacing: 4) {
            Text(row.text).font(.body).foregroundStyle(Theme.ink).textSelection(.enabled)
                .padding(.horizontal, 12).padding(.vertical, 9)
                .background(row.isYou ? Theme.surfaceRaised : Color.clear, in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke(row.failed ? Theme.needsYou : row.isYou ? Theme.lineStrong : Theme.line))
            if let status = row.status {
                HStack(spacing: 8) {
                    Text(status).font(.caption).foregroundStyle(row.failed ? Theme.needsYou : Theme.muted)
                    if row.failed, let local = row.local {
                        Button { Task { await model.sendFilmChat(film, text: row.text, retrying: local) } } label: {
                            Text("Send again").font(.caption.weight(.semibold)).foregroundStyle(Theme.ink).frame(minHeight: 44)
                        }
                        .buttonStyle(.press)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: row.isYou ? .trailing : .leading)
        .padding(.leading, row.isYou ? 40 : 0).padding(.trailing, row.isYou ? 0 : 40)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.isYou ? "You" : "Rasan"): \(row.text)\(row.status.map { ", \($0)" } ?? "")")
    }

    @ViewBuilder private var composer: some View {
        if let reason {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
                Text(reason).font(.footnote).foregroundStyle(Theme.muted)
            }
        } else {
            let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask Rasan", text: $draft, axis: .vertical)
                    .lineLimit(1...5).focused($focused)
                    .onChange(of: draft) { _, new in if new.count > 2000 { draft = String(new.prefix(2000)) } }
                    .modifier(FieldBox())
                Button {
                    let sent = draft
                    draft = ""
                    Task { await model.sendFilmChat(film, text: sent) }
                } label: {
                    Lucide(.arrowUp, size: 18, label: "Send", color: text.isEmpty ? Theme.muted : Theme.primaryText)
                        .frame(width: 44, height: 44)
                        .background(text.isEmpty ? Theme.surfaceRaised : Theme.primaryFill, in: Circle())
                }
                .buttonStyle(.press)
                .disabled(text.isEmpty)
            }
        }
    }
}
#endif
