import SwiftUI
import Weave
import SWCSync
import SWCWire

/// The composer's options chip: the thread's model and its options in a line
/// ("Opus 5.5 · High · Ultracode"), opening the same choices as the desktop's
/// options menu: the model, its options and access. The model and its options
/// apply from the next message.
struct ModelOptionsMenu: View {
  let model: String
  let traits: ModelTraits?
  let runtimeMode: RuntimeModeChoice?
  /// The models the thread can switch to, and the one checked.
  var models: [ModelChoice] = []
  var selectedModelId: String?
  /// A model or options chosen here and not sent yet.
  let hasPendingChanges: Bool
  let onSet: (String, ModelOption.Value) -> Void
  var onModel: (ModelChoice) -> Void = { _ in }
  let onAccess: (RuntimeModeChoice) -> Void

  var body: some View {
    Menu {
      if models.count > 1 {
        Section {
          Menu {
            let groups = ModelChoice.grouped(models)
            if groups.count == 1, let only = groups.first {
              modelButtons(only.models)
            } else {
              ForEach(groups, id: \.instanceId) { group in
                Menu {
                  modelButtons(group.models)
                } label: {
                  Text(group.provider)
                  if let picked = group.models.first(where: { $0.id == selectedModelId }) { Text(picked.name) }
                }
              }
            }
          } label: {
            Text("Model")
            Text(model)
          }
          .accessibilityIdentifier("chat.model-picker")
        }
      }
      if let traits, !traits.isEmpty {
        Section(model) {
          ForEach(traits.controls) { control in
            switch control.kind {
            case let .select(choices, current):
              Picker(selection: Binding<String?>(get: { current }, set: { if let value = $0 { onSet(control.id, .string(value)) } })) {
                ForEach(choices) { choice in
                  Text(choice.label).tag(Optional(choice.id))
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
      if traits?.isEmpty == false || models.count > 1 {
        Section {
          Text(models.count > 1 ? "Model and options apply from your next message." : "Model options apply from your next message.")
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
    .accessibilityHint(hasPendingChanges ? "Changes apply from your next message" : "Shows the model, reasoning, Ultracode, fast mode and access")
    .accessibilityIdentifier("chat.model-options")
  }

  @ViewBuilder
  private func modelButtons(_ choices: [ModelChoice]) -> some View {
    ForEach(choices) { choice in
      Button {
        onModel(choice)
      } label: {
        if choice.id == selectedModelId {
          Label(choice.name, systemImage: "checkmark")
        } else {
          Text(choice.name)
        }
      }
    }
  }

  private var label: String {
    let summary = traits?.summary ?? ""
    return summary.isEmpty ? model : "\(model) · \(summary)"
  }
}
