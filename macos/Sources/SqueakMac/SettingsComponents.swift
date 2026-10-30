import SqueakMacCore
import SwiftUI

/// Shared settings vocabulary: a named purpose, a short explanation, then native controls.
struct SettingsCard<Content: View>: View {
    let title: String
    let subtitle: String
    let symbol: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .frame(width: 34, height: 34)
                    .background(Theme.duck.opacity(0.16), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(Typo.heading).foregroundStyle(Theme.ink)
                        .accessibilityAddTraits(.isHeader)
                    Text(subtitle).font(Typo.body).foregroundStyle(Theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface.opacity(0.82), in: RoundedRectangle(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).strokeBorder(Theme.line) }
    }
}

struct SettingsControlLabel: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Typo.label).foregroundStyle(Theme.ink)
            Text(detail).font(Typo.body).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview("Settings card · light") {
    SettingsCard(title: "Your Mac, your way", subtitle: "Small preferences that make Squeak feel at home.", symbol: "slider.horizontal.3") {
        Toggle(isOn: .constant(true)) {
            SettingsControlLabel(title: "Open at login", detail: "Keep your agents close whenever you start your Mac.")
        }
        .toggleStyle(.switch)
    }
    .padding(24).frame(width: 600).background(Theme.bg).preferredColorScheme(.light)
}

#Preview("Settings card · dark") {
    SettingsCard(title: "Your Mac, your way", subtitle: "Small preferences that make Squeak feel at home.", symbol: "slider.horizontal.3") {
        Toggle(isOn: .constant(true)) {
            SettingsControlLabel(title: "Open at login", detail: "Keep your agents close whenever you start your Mac.")
        }
        .toggleStyle(.switch)
    }
    .padding(24).frame(width: 600).background(Theme.bg).preferredColorScheme(.dark)
}

struct ChatPresetSummary: View {
    let preset: ChatPreset
    let name: String
    let model: String?

    private var symbol: String {
        switch preset { case .best: "sparkles"; case .balanced: "scale.3d"; case .save: "leaf"; default: "slider.horizontal.3" }
    }

    private var detail: String {
        switch preset {
        case .best: "For your most demanding work"
        case .balanced: "A balance of capability and cost"
        case .save: "For lighter, everyday tasks"
        default: "Your custom starting point"
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.system(size: 17)).foregroundStyle(Theme.muted)
                .frame(width: 24, height: 26).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(name).font(Typo.heading).foregroundStyle(Theme.ink)
                Text(detail).font(Typo.body).foregroundStyle(Theme.muted)
                if let model { Text(model).font(Typo.meta).foregroundStyle(Theme.muted).padding(.top, 3) }
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

#Preview("New chat presets") {
    SettingsCard(title: "New chat presets", subtitle: "Give each kind of work a familiar starting point.", symbol: "sparkles") {
        ForEach([ChatPreset.best, .balanced, .save], id: \.self) { preset in
            DisclosureGroup { Text("Model and thinking preferences") } label: {
                ChatPresetSummary(preset: preset, name: preset.title, model: "Claude Sonnet")
            }
            .padding(16)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        }
    }
    .padding(24).frame(width: 620).background(Theme.bg)
}
