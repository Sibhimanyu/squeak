import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI
import UniformTypeIdentifiers

/// Pond icons the host holds, fetched with the token and cached by their `iconUpdatedAt`.
@MainActor @Observable
final class PondIcons {
    static let shared = PondIcons()
    private var images: [String: NSImage] = [:]
    @ObservationIgnored private var loading: Set<String> = []

    private func stamp(_ p: NativeProject) -> String { "\(p.id)@\(p.iconUpdatedAt ?? p.iconUrl ?? "")" }

    func image(for p: NativeProject?) -> NSImage? {
        guard let p, p.iconUrl != nil else { return nil }
        return images[stamp(p)]
    }

    /// The logo's palette (dominant first), from the cached image; empty while it loads or when it is greyscale.
    func logoHues(for p: NativeProject?) -> [Double] {
        guard let img = image(for: p) else { return [] }
        return Self.hues(of: img)
    }

    static func hues(of image: NSImage) -> [Double] {
        let n = 32
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: n * 4, bitsPerPixel: 32),
            let data = rep.bitmapData else { return [] }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(x: 0, y: 0, width: n, height: n))
        NSGraphicsContext.restoreGraphicsState()
        return LogoPalette.hues(rgba: Array(UnsafeBufferPointer(start: data, count: n * n * 4)), width: n, height: n)
    }

    func sync(_ projects: [NativeProject], host: NativeHostClient) async {
        for p in projects where p.iconUrl != nil {
            let key = stamp(p)
            guard images[key] == nil, !loading.contains(key) else { continue }
            loading.insert(key)
            defer { loading.remove(key) }
            if let data = try? await host.projectIcon(key: p.id), let img = NSImage(data: data) { images[key] = img }
        }
    }
}

/// The saved pond order. The host keeps it (`/native/pond-order`); a host that answers 404 is older than the route, so
/// the order lives in UserDefaults instead. Either way the last known value is cached locally for the next launch.
@MainActor @Observable
final class PondOrderStore {
    static let shared = PondOrderStore()
    private static let defaultsKey = "sidebarPondOrder"
    private(set) var state: PondOrderState
    @ObservationIgnored private var hostKnowsRoute = true

    init(defaults: UserDefaults = .standard) {
        state = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(PondOrderState.self, from: $0) } ?? PondOrderState()
    }

    func load(host: NativeHostClient) async {
        // A thrown error (host down) keeps what we have; nil is an older host (404).
        let result: PondOrderState?
        do { result = try await host.pondOrder() } catch { return }
        guard let remote = result else { hostKnowsRoute = false; return }
        hostKnowsRoute = true
        if remote != state { state = remote; cache() }
    }

    func set(mode: PondOrderMode? = nil, order: [String]? = nil, host: NativeHostClient?) {
        if let mode { state.mode = mode }
        if let order { state.order = order }
        cache()
        guard let host else { return }
        let (m, o) = (mode, order)
        Task { [hostKnowsRoute] in
            guard hostKnowsRoute else { return }
            _ = try? await host.setPondOrder(mode: m, order: o)
        }
    }

    private func cache() {
        if let data = try? JSONEncoder().encode(state) { UserDefaults.standard.set(data, forKey: Self.defaultsKey) }
    }
}

/// The Ponds header: its title and a funnel menu (all, each label with its count, show hidden).
struct PondsHeader: View {
    let labels: [PondLabelCount]
    @Binding var label: String
    @Binding var showHidden: Bool
    var order: PondOrderMode = .recent
    var setOrder: (PondOrderMode) -> Void = { _ in }

    var body: some View {
        HStack(spacing: 4) {
            Text(PondWords.sidebarHeader).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.muted)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            SqueakMenu {
                Button { label = "" } label: { Text(verbatim: label.isEmpty ? "✓ All ponds" : "All ponds") }
                ForEach(labels, id: \.label) { l in
                    Button { label = l.label } label: {
                        Text(verbatim: "\(label.lowercased() == l.label.lowercased() ? "✓ " : "")\(l.label) (\(l.count))")
                    }
                }
                Divider()
                Text("Order")
                Button { setOrder(.recent) } label: { Text(verbatim: order == .recent ? "✓ Recent activity" : "Recent activity") }
                Button { setOrder(.manual) } label: { Text(verbatim: order == .manual ? "✓ My order" : "My order") }
                Divider()
                Toggle("Show hidden", isOn: $showHidden)
            } label: {
                Image(systemName: "line.3.horizontal.decrease").font(.system(size: 12, weight: .medium)).foregroundStyle(label.isEmpty ? Theme.subtle : Theme.ink).frame(width: 24, height: 22).contentShape(Rectangle())
            }
            .menuStyle(.button).menuIndicator(.hidden).buttonStyle(.plain).fixedSize()
            .help("Filter ponds").accessibilityLabel("Filter ponds")
        }
        .padding(.horizontal, Space.l).padding(.top, 14).padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The active label filter, quiet under the header, with an × to clear.
struct PondFilterChip: View {
    let label: String
    let clear: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: label).font(Typo.meta).foregroundStyle(Theme.ink).lineLimit(1)
            Button(action: clear) { Lucide(.x, size: 10, color: Theme.muted) }.buttonStyle(.plain)
                .help("Show all ponds").accessibilityLabel("Clear the \(label) filter")
        }
        .padding(.horizontal, 8).frame(height: 22)
        .background(Theme.selected, in: Capsule())
        .padding(.horizontal, Space.l).padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// "Labels…": existing labels as toggle chips, and a field to add one.
struct PondLabelsPopover: View {
    let project: NativeProject
    let known: [String]
    let save: ([String]) -> Void
    @State private var labels: [String] = []
    @State private var draft = ""

    private var choices: [String] {
        var out = labels
        for k in known where !out.contains(where: { $0.lowercased() == k.lowercased() }) { out.append(k) }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Labels for \(project.name)").font(Typo.label).foregroundStyle(Theme.ink)
            if !choices.isEmpty {
                FlowChips(items: choices) { l in
                    let on = labels.contains { $0.lowercased() == l.lowercased() }
                    Button { toggle(l, on: on) } label: {
                        Text(verbatim: l).font(Typo.meta).foregroundStyle(on ? Theme.ink : Theme.muted)
                            .padding(.horizontal, 8).frame(height: 22)
                            .background(on ? Theme.selected : .clear, in: Capsule())
                            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
                    }.buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            TextField("Add a label", text: $draft).textFieldStyle(.roundedBorder).onSubmit(add)
            if labels.count >= PondFilter.maxLabelsPerPond {
                Text("A pond takes up to \(PondFilter.maxLabelsPerPond) labels.").font(Typo.meta).foregroundStyle(Theme.subtle)
            }
        }
        .padding(Space.m).frame(width: 260)
        .onAppear { labels = project.labels }
    }

    private func toggle(_ l: String, on: Bool) {
        if on { labels.removeAll { $0.lowercased() == l.lowercased() } }
        else if let next = PondFilter.adding(l, to: labels) { labels = next } else { return }
        save(labels)
    }

    private func add() {
        if let next = PondFilter.adding(draft, to: labels) { labels = next; draft = ""; save(labels) }
    }
}

/// Wraps chips onto as many lines as they need.
struct FlowChips<Item: Hashable, Chip: View>: View {
    let items: [Item]
    @ViewBuilder let chip: (Item) -> Chip
    var body: some View {
        ChipFlowLayout(spacing: 6) { ForEach(items, id: \.self) { chip($0) } }
    }
}

private struct ChipFlowLayout: Layout {
    var spacing: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? 240, subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let r = arrange(bounds.width, subviews)
        for (i, o) in r.origins.enumerated() { subviews[i].place(at: CGPoint(x: bounds.minX + o.x, y: bounds.minY + o.y), proposal: .unspecified) }
    }
    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, row: CGFloat = 0, maxX: CGFloat = 0
        var origins: [CGPoint] = []
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x > 0, x + sz.width > width { x = 0; y += row + spacing; row = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += sz.width + spacing; row = max(row, sz.height); maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + row), origins)
    }
}

/// Pond settings: the icon (change, drop an image, remove) and the colour, applied at once.
struct PondLookSection: View {
    let project: NativeProject
    @Environment(AppModel.self) private var model
    @State private var problem: String?
    @State private var dropping = false

    private let grid = [GridItem(.adaptive(minimum: 28, maximum: 32), spacing: 8)]
    private var logoHues: [Double] { PondIcons.shared.logoHues(for: current) }

    private var current: NativeProject { model.native.projects.first { $0.id == project.id } ?? project }

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Icon").font(Typo.label).foregroundStyle(Theme.ink)
                HStack(spacing: Space.m) {
                    icon.frame(width: 48, height: 48)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(dropping ? PondColour.accent : Theme.line, lineWidth: dropping ? 2 : 1))
                        .dropDestination(for: URL.self) { urls, _ in
                            guard let url = urls.first else { return false }
                            upload(url); return true
                        } isTargeted: { dropping = $0 }
                    Button("Change icon…") { choose() }.buttonStyle(SecondaryButtonStyle())
                    if current.iconUrl != nil { Button("Remove icon") { remove() }.buttonStyle(SecondaryButtonStyle()) }
                }
                Text("PNG or JPEG. You can also drop an image onto the icon.")
                    .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text("Colour").font(Typo.label).foregroundStyle(Theme.ink)
                if !logoHues.isEmpty {
                    Text("From the logo").font(Typo.meta).foregroundStyle(Theme.muted)
                    LazyVGrid(columns: grid, alignment: .leading, spacing: 8) {
                        ForEach(Array(logoHues.enumerated()), id: \.offset) { i, hue in
                            swatch(name: PondColours.value(hue: hue), fill: PondColour.swatch(hue: hue), label: "Logo colour \(i + 1)",
                                   on: current.colour == PondColours.value(hue: hue) || (current.colour == nil && i == 0))
                        }
                    }
                    Text("Other colours").font(Typo.meta).foregroundStyle(Theme.muted)
                }
                LazyVGrid(columns: grid, alignment: .leading, spacing: 8) {
                    swatch(name: nil, fill: PondColour.tint(nil), label: "Default", on: current.colour == nil && logoHues.isEmpty)
                    ForEach(PondColours.all, id: \.name) { c in swatch(name: c.name, fill: PondColour.swatch(hue: c.hue), label: c.name.capitalized) }
                }
            }
            if let problem { Text(verbatim: problem).font(Typo.body).foregroundStyle(Theme.negative) }
        }
    }

    @ViewBuilder private var icon: some View {
        if let img = PondIcons.shared.image(for: current) {
            Image(nsImage: img).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 10))
        } else {
            PondTile(name: project.name, pondId: PondsModel.shared.pond(named: project.name)?.id, size: 48)
        }
    }

    private func swatch(name: String?, fill: Color, label: String, on: Bool? = nil) -> some View {
        let on = on ?? (current.colour == name)
        return Button { setColour(name) } label: {
            Circle().fill(fill).frame(width: 24, height: 24)
                .overlay(Circle().stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 2 : 1))
                .overlay {
                    if on { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.ink) }
                    else if name == nil { Lucide(.x, size: 10, color: Theme.subtle) }
                }
                .frame(width: 30, height: 30).contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(label).accessibilityLabel("\(label) colour").accessibilityAddTraits(on ? .isSelected : [])
    }

    private func setColour(_ name: String?) {
        guard !model.demoMode else { return }
        run { try await model.nativeHost.setProjectPrefs(key: project.id, colour: .some(name)) }
    }

    private func choose() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.png, .jpeg]
        panel.allowsMultipleSelection = false
        panel.message = "Choose an icon for \(project.name)"
        if panel.runModal() == .OK, let url = panel.url { upload(url) }
    }

    private func upload(_ url: URL) {
        guard !model.demoMode else { return }
        guard let data = try? Data(contentsOf: url), let img = NSImage(data: data), let png = Self.small(img) else {
            problem = "That isn't a PNG or JPEG image."; return
        }
        // The logo's dominant hue becomes the pond's colour unless the person chose a named one.
        let auto = PondIcons.hues(of: img).first.map(PondColours.value(hue:))
        let colour = current.colour
        run {
            try await model.nativeHost.setProjectIcon(key: project.id, image: png, mime: "image/png")
            if colour == nil || PondColours.isLogoValue(colour) {
                try await model.nativeHost.setProjectPrefs(key: project.id, colour: .some(auto))
            }
        }
    }

    private func remove() {
        guard !model.demoMode else { return }
        let colour = current.colour
        run {
            try await model.nativeHost.removeProjectIcon(key: project.id)
            if PondColours.isLogoValue(colour) { try await model.nativeHost.setProjectPrefs(key: project.id, colour: .some(nil)) }
        }
    }

    private func run(_ work: @escaping () async throws -> Void) {
        problem = nil
        Task {
            do { try await work(); await model.refreshNativeProjects() }
            catch let e as NativeHostError { problem = e.reason } catch { problem = "Squeak couldn't save that" }
        }
    }

    /// The image as a PNG at most 256 px on a side.
    static func small(_ image: NSImage) -> Data? {
        guard let rep = image.representations.first else { return nil }
        let w = CGFloat(rep.pixelsWide > 0 ? rep.pixelsWide : Int(image.size.width)), h = CGFloat(rep.pixelsHigh > 0 ? rep.pixelsHigh : Int(image.size.height))
        guard w > 0, h > 0 else { return nil }
        let k = min(1, 256 / max(w, h))
        let size = NSSize(width: max(1, (w * k).rounded()), height: max(1, (h * k).rounded()))
        guard let out = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width), pixelsHigh: Int(size.height), bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: out)
        image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return out.representation(using: .png, properties: [:])
    }
}
