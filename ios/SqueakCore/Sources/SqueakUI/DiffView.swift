#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// What a chat changed (DESIGN.md §8.8): the file list first, one file's patch second, as Telegram
/// does. Read from the Mac on open; nothing is kept on the phone after the sheet closes.
struct DiffView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let session: PhoneSnapshot.Session
    @State private var diff: WorkspaceDiff?
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Group {
                if let diff {
                    List {
                        Section {
                            ForEach(Array(diff.files.enumerated()), id: \.offset) { index, file in
                                NavigationLink {
                                    PatchView(session: session, file: file, index: index)
                                } label: {
                                    FileRow(file: file)
                                }
                                .listRowBackground(Theme.surface)
                            }
                        } footer: {
                            if diff.truncated { Text("Only the first \(diff.files.count) files are listed.") }
                        }
                    }
                    .scrollContentBackground(.hidden)
                } else if let problem {
                    ContentUnavailableView {
                        Label { Text("Couldn't load the changes") } icon: { Lucide(.circleAlert, size: 28, color: Theme.muted) }
                    } description: { Text(problem) } actions: {
                        Button("Try again") { Task { await load() } }
                    }
                } else {
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("Reading the changes on your Mac…").foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(diff.map { "\($0.files.count) file\($0.files.count == 1 ? "" : "s") · +\($0.insertions) −\($0.deletions)" } ?? "What changed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
        .foregroundStyle(Theme.ink)
        .task { await load() }
    }

    private func load() async {
        problem = nil
        switch await model.loadDiff(session) {
        case let .diff(diff, _): self.diff = diff
        case let .refused(why): problem = why
        }
    }
}

/// A file: its path, truncated from the start so the name stays (§8.8), and its counts.
private struct FileRow: View {
    let file: WorkspaceDiff.File

    var body: some View {
        HStack(spacing: 10) {
            Text(file.path).font(.system(.subheadline, design: .monospaced)).lineLimit(1).truncationMode(.head)
            Spacer(minLength: 6)
            if file.binary {
                Text("binary").font(.caption).foregroundStyle(Theme.muted)
            } else {
                Text(file.untracked ? "new · +\(file.insertions)" : "+\(file.insertions) −\(file.deletions)")
                    .font(.caption.monospacedDigit()).foregroundStyle(Theme.muted)
            }
        }
        .frame(minHeight: 36)
        .accessibilityElement(children: .combine)
    }
}

/// One file's patch, mono, added lines on a 12% working-green tint, removed on a 12% red tint.
private struct PatchView: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let file: WorkspaceDiff.File
    let index: Int
    @State private var text: String?
    @State private var problem: String?

    var body: some View {
        Group {
            if let text {
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(text.split(separator: "\n", omittingEmptySubsequences: false).enumerated()), id: \.offset) { _, line in
                            PatchLine(line: String(line))
                        }
                    }
                    .padding(.vertical, 8)
                    .textSelection(.enabled)
                }
            } else if let problem {
                ContentUnavailableView {
                    Label { Text("Couldn't load this file") } icon: { Lucide(.circleAlert, size: 28, color: Theme.muted) }
                } description: { Text(problem) }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle((file.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            switch await model.loadDiff(session, file: index) {
            case let .diff(_, patch):
                if let patch, patch.path == file.path { text = patch.text.isEmpty ? "No textual changes." : patch.text } else {
                    problem = "The changes moved on since the list was read. Go back and open it again."
                }
            case let .refused(why): problem = why
            }
        }
    }
}

private struct PatchLine: View {
    let line: String

    var body: some View {
        Text(line.isEmpty ? " " : line)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(line.hasPrefix("@@") ? Theme.muted : Theme.ink)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 12).padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint)
    }

    private var tint: Color {
        if line.hasPrefix("+") { return Theme.working.opacity(0.12) }
        if line.hasPrefix("-") { return Theme.needsYou.opacity(0.12) }
        return .clear
    }
}
#endif
