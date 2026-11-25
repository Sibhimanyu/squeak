import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: the side pane beside the centre. It holds one thing, the Terminal: no title row, no pin, no back row.
// Changes, Files and Artifacts are the rail's one-shot lists and open as tabs. Esc, the Terminal icon and a page change
// close it.

struct WorkPanePane: View {
    let scope: WorkPaneScope
    let width: CGFloat

    var body: some View {
        WorkPaneTerminal(scope: scope)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipped()
            .frame(width: width)
            .frame(maxHeight: .infinity)
            .background(Theme.bg.ignoresSafeArea())
            .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }
}

/// The Duck's (or the Pond's folder's) terminal, in the pane (there is no bottom dock in the new layout). Shell chips appear with a second shell.
/// Flows: "+" opens another shell in the folder; a chip switches between shells; the Terminal icon or Esc closes the pane.
private struct WorkPaneTerminal: View {
    let scope: WorkPaneScope
    private let host = TerminalHost.shared

    private var cwd: String? {
        switch scope {
        case .duck(let s): s.cwd
        case .pond(let p): p.root
        }
    }

    var body: some View {
        let folder = TerminalWorkspace.availability(cwd: cwd).folder
        let tabs = folder.map { host.registry.tabs($0) } ?? []
        let selected = folder.flatMap { host.registry.selected($0)?.id }
        VStack(spacing: 0) {
            if let folder {
                HStack(spacing: 4) {
                    ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                        Button { host.select(workspace: folder, tab.id) } label: {
                            Text(verbatim: InspectorLowerTab.terminalTitle(number: index + 1)).font(Typo.label)
                                .foregroundStyle(selected == tab.id ? Theme.ink : Theme.muted)
                                .padding(.horizontal, 8).frame(height: 24)
                                .background(selected == tab.id ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                    Button { host.add(workspace: folder, folder: folder) } label: {
                        Lucide(.plus, size: 14, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("New shell").accessibilityLabel("New shell")
                }
                .padding(.horizontal, Space.s).frame(height: 32)
                Rectangle().fill(Theme.line).frame(height: 1)
            }
            switch scope {
            case .duck(let session): TerminalPanelView(session: session)
            case .pond(let p): TerminalPanelView(session: nil, cwd: p.root)
            }
        }
        .onAppear {
            host.focusPending = true
            KeyFocus.shared.setTerminalOpen(true)
        }
        .onDisappear { KeyFocus.shared.setTerminalOpen(false) }
    }
}
