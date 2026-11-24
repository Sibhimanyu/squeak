import SqueakIcons
import SqueakMacCore
import SwiftUI

// The pond page's "Canvases" section: the pond's canvases newest first, and "+ New canvas" with the kinds. The list is
// the host's (`GET /native/projects/<id>/canvases`) and follows the pond's artifacts stream, which also fires when a
// duck makes or changes a canvas.

@MainActor @Observable
final class CanvasesModel {
    private(set) var items: [CanvasSummary] = []
    private(set) var loaded = false
    private(set) var note: String?
    private var projectId = ""

    /// Reads now and again on every push of the pond's artifacts stream, until the task is cancelled.
    func follow(_ id: String, host: NativeHostClient) async {
        if id != projectId { items = []; loaded = false; note = nil }
        projectId = id
        await read(id, host)
        for await _ in host.artifactEvents(projectId: id) {
            guard !Task.isCancelled else { return }
            await read(id, host)
        }
    }

    private func read(_ id: String, _ host: NativeHostClient) async {
        guard let rows = try? await host.canvases(projectId: id), projectId == id else { loaded = true; return }
        if rows != items { items = rows }
        loaded = true
    }

    /// Makes a canvas and returns it (nil, with a note, when the host refused).
    func create(_ kind: CanvasKind, in id: String, host: NativeHostClient) async -> CanvasSummary? {
        do {
            let made = try await host.createCanvas(projectId: id, title: kind.defaultTitle, kind: kind)
            note = nil
            await read(id, host)
            return made
        } catch {
            note = "Squeak couldn\u{2019}t make the canvas. Try again."
            return nil
        }
    }
}

struct CanvasesSection: View {
    let pondKey: String
    let projectId: String
    @Environment(AppModel.self) private var model
    @State private var canvases = CanvasesModel()

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack(alignment: .firstTextBaseline) {
                Text("Canvases").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                Spacer()
                Menu {
                    ForEach(CanvasKind.allCases, id: \.self) { kind in
                        Button(kind.menuTitle) { make(kind) }
                    }
                } label: { Label("New canvas", systemImage: "plus") }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .font(Typo.footnote).foregroundStyle(Theme.ink).accessibilityLabel("New canvas")
            }
            if canvases.items.isEmpty {
                Text(canvases.loaded ? "Decks, posters, logo sheets and social posts that ducks draw for you. Make one, or ask a duck." : "")
                    .font(Typo.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 2) {
                    ForEach(canvases.items) { c in CanvasRow(canvas: c) { model.openCanvas(pond: pondKey, path: c.path) } pin: { model.openCanvas(pond: pondKey, path: c.path, pin: true) } }
                }
                .padding(Space.xs).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
            if let note = canvases.note { Text(verbatim: note).font(Typo.footnote).foregroundStyle(Theme.negative) }
        }
        .task(id: projectId) { await canvases.follow(projectId, host: model.nativeHost) }
    }

    private func make(_ kind: CanvasKind) {
        Task {
            if let made = await canvases.create(kind, in: projectId, host: model.nativeHost) {
                model.openCanvas(pond: pondKey, path: made.path, pin: true)
            }
        }
    }
}

private struct CanvasRow: View {
    let canvas: CanvasSummary
    let open: () -> Void
    let pin: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s) {
                Lucide(.layers, size: 16, color: Theme.muted).frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: canvas.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                    Text(verbatim: CanvasBoards.meta(canvas)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, Space.s).padding(.vertical, 5)
            .background(hovering ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .simultaneousGesture(TapGesture(count: 2).onEnded { pin() })
        .accessibilityLabel("Open canvas \(canvas.title)")
    }
}

/// A remote pond's canvases: the owner's, listed from the same remote artifacts the Artifacts tab asks for (a canvas folder
/// is an output there), opened view-only. Nothing shows until the owner's Mac has listed one.
struct RemoteCanvasesSection: View {
    let pondKey: String
    @Environment(AppModel.self) private var model

    private var feed: RemoteArtifactsModel { RemoteArtifactsStore.shared.model(for: pondKey) }

    var body: some View {
        let canvases = feed.items.filter { $0.kind == .canvas }
        VStack(alignment: .leading, spacing: Space.s) {
            if !canvases.isEmpty {
                HStack(alignment: .firstTextBaseline) {
                    Text("Canvases").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    Text("View only").font(Typo.footnote).foregroundStyle(Theme.subtle)
                    Spacer()
                }
                VStack(spacing: 2) {
                    ForEach(canvases) { c in
                        RemoteCanvasRow(item: c) { model.openCanvas(pond: pondKey, path: c.path) } pin: { model.openCanvas(pond: pondKey, path: c.path, pin: true) }
                    }
                }
                .padding(Space.xs).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
        }
        .task(id: pondKey) {
            guard let id = PondsModel.shared.pond(key: pondKey)?.id else { return }
            feed.load(pondId: id, host: model.nativeHost)
        }
    }
}

private struct RemoteCanvasRow: View {
    let item: ArtifactItem
    let open: () -> Void
    let pin: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: open) {
            HStack(spacing: Space.s) {
                Lucide(.layers, size: 16, color: Theme.muted).frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: (item.name as NSString).deletingPathExtension).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                    Text(verbatim: Artifacts.meta(item)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.tail)
                }
                Spacer(minLength: 4)
            }
            .padding(.horizontal, Space.s).padding(.vertical, 5)
            .background(hovering ? Theme.selected : Color.clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .simultaneousGesture(TapGesture(count: 2).onEnded { pin() })
        .accessibilityLabel("Open canvas \((item.name as NSString).deletingPathExtension), view only")
    }
}
