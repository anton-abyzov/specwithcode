import SwiftUI
import Weave
import SWCSync
import SWCWire

/// The composer's model chip, in two parts inside one capsule. The model's
/// name opens the model picker; the options beside it ("High · Ultracode")
/// open the same choices as the desktop's options menu: the model's options
/// and access. Both apply from the next message.
///
/// Equal inputs skip the body: a menu rebuilt while it is open loses its
/// scroll position, and the chat around this chip redraws as a reply streams.
struct ModelOptionsMenu: View, Equatable {
  let model: String
  /// The logo of the provider that serves the model, when it has one.
  var brand: String?
  let traits: ModelTraits?
  let runtimeMode: RuntimeModeChoice?
  /// Whether the thread has another model to switch to.
  var canChooseModel = false
  /// A model or options chosen here and not sent yet.
  let hasPendingChanges: Bool
  let onSet: (String, ModelOption.Value) -> Void
  var onChooseModel: () -> Void = {}
  let onAccess: (RuntimeModeChoice) -> Void

  nonisolated static func == (a: ModelOptionsMenu, b: ModelOptionsMenu) -> Bool {
    a.model == b.model && a.brand == b.brand && a.traits == b.traits && a.runtimeMode == b.runtimeMode
      && a.canChooseModel == b.canChooseModel && a.hasPendingChanges == b.hasPendingChanges
  }

  private var hasOptions: Bool { traits?.isEmpty == false || runtimeMode != nil }
  private var summary: String { traits?.summary ?? "" }

  var body: some View {
    HStack(spacing: 0) {
      if canChooseModel {
        Button(action: onChooseModel) {
          HStack(spacing: WeaveSpacing.s1) {
            if let brand { ProviderMark(brand, size: 14) }
            Text(model)
              .lineLimit(1)
              .truncationMode(.middle)
            if !hasOptions { pendingDot }
            Image(systemName: "chevron.down")
              .font(.system(size: 9, weight: .semibold))
          }
          .padding(.leading, WeaveSpacing.s3)
          .padding(.trailing, hasOptions ? WeaveSpacing.s2 : WeaveSpacing.s3)
          .frame(minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .accessibilityLabel("Model, \(model)")
        .accessibilityHint("Shows the models this thread can switch to")
        .accessibilityIdentifier("chat.model-picker")
        if hasOptions {
          Rectangle()
            .fill(Color.weave.muted.opacity(0.35))
            .frame(width: WeaveSize.hairline, height: 16)
            .accessibilityHidden(true)
        }
      }
      if hasOptions { optionsMenu }
    }
    .font(.weave(.caption, weight: .medium))
    .foregroundStyle(Color.weave.muted)
    .frame(height: 32)
    .weaveGlass(in: Capsule(), interactive: true)
    .frame(minHeight: WeaveSize.minTap)
  }

  @ViewBuilder private var pendingDot: some View {
    if hasPendingChanges {
      Circle().fill(Color.weave.iris).frame(width: 6, height: 6)
        .accessibilityHidden(true)
    }
  }

  private var optionsMenu: some View {
    Menu {
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
      if traits?.isEmpty == false {
        Section {
          Text("Model options apply from your next message.")
        }
      }
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        Image(systemName: "slider.horizontal.3")
          .font(.system(size: 12, weight: .semibold))
        if !canChooseModel || !summary.isEmpty {
          Text(canChooseModel ? summary : label)
            .lineLimit(1)
            .truncationMode(canChooseModel ? .tail : .middle)
        }
        pendingDot
        if !canChooseModel {
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 9, weight: .semibold))
        }
      }
      .padding(.leading, canChooseModel ? WeaveSpacing.s2 : WeaveSpacing.s3)
      .padding(.trailing, WeaveSpacing.s3)
      .frame(minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .menuIndicator(.hidden)
    .menuOrder(.fixed)
    .buttonStyle(.plain)
    .accessibilityLabel("Model options, \(label)")
    .accessibilityHint(hasPendingChanges ? "Changes apply from your next message" : "Shows reasoning, Ultracode, fast mode and access")
    .accessibilityIdentifier("chat.model-options")
  }

  private var label: String {
    summary.isEmpty ? model : "\(model) · \(summary)"
  }
}
