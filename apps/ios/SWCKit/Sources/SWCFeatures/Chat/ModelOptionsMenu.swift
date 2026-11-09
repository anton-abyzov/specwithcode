import SwiftUI
import Weave
import SWCSync
import SWCWire

/// The composer's options chip: the thread's model and its options in a line
/// ("Opus 5.5 · High · Ultracode"), opening the same choices as the desktop's
/// options menu. Model options apply from the next message; access at once.
struct ModelOptionsMenu: View {
  let model: String
  let traits: ModelTraits?
  let runtimeMode: RuntimeModeChoice?
  /// Options chosen here and not sent yet.
  let hasPendingChanges: Bool
  let onSet: (String, ModelOption.Value) -> Void
  let onAccess: (RuntimeModeChoice) -> Void

  var body: some View {
    Menu {
      if let traits, !traits.isEmpty {
        Section(model) {
          ForEach(traits.controls) { control in
            switch control.kind {
            case let .select(choices, current):
              Picker(selection: Binding(get: { current ?? "" }, set: { onSet(control.id, .string($0)) })) {
                ForEach(choices) { choice in
                  Text(choice.label).tag(choice.id)
                }
              } label: {
                Text(control.label)
                Text(choices.first { $0.id == current }?.label ?? "Default")
              }
              .pickerStyle(.menu)
            case let .toggle(current):
              Toggle(isOn: Binding(get: { current == true }, set: { onSet(control.id, .bool($0)) })) {
                Text(control.label)
                if let detail = control.detail { Text(detail) }
              }
            }
          }
        }
      }
      if let runtimeMode {
        Section {
          Picker(selection: Binding(get: { runtimeMode }, set: { onAccess($0) })) {
            ForEach(RuntimeModeChoice.allCases, id: \.self) { mode in
              Text(mode.label).tag(mode)
            }
          } label: {
            Text("Access")
            Text(runtimeMode.label)
          }
          .pickerStyle(.menu)
        }
      }
      if traits?.isEmpty == false {
        Section {
          Text("Model options apply from your next message.")
        }
      }
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        Image(systemName: "slider.horizontal.3")
          .font(.system(size: 12, weight: .semibold))
        Text(label)
          .lineLimit(1)
          .truncationMode(.middle)
        if hasPendingChanges {
          Circle().fill(Color.weave.iris).frame(width: 6, height: 6)
            .accessibilityHidden(true)
        }
        Image(systemName: "chevron.up.chevron.down")
          .font(.system(size: 9, weight: .semibold))
      }
      .font(.weave(.caption, weight: .medium))
      .foregroundStyle(Color.weave.muted)
      .padding(.horizontal, WeaveSpacing.s3)
      .frame(minHeight: 32)
      .weaveGlass(in: Capsule(), interactive: true)
      .contentShape(Capsule())
      .frame(minHeight: WeaveSize.minTap)
    }
    .menuIndicator(.hidden)
    .menuOrder(.fixed)
    .buttonStyle(.plain)
    .accessibilityLabel("Model options, \(label)")
    .accessibilityHint(hasPendingChanges ? "Changed options apply from your next message" : "Shows reasoning, Ultracode, fast mode and access")
    .accessibilityIdentifier("chat.model-options")
  }

  private var label: String {
    let summary = traits?.summary ?? ""
    return summary.isEmpty ? model : "\(model) · \(summary)"
  }
}
