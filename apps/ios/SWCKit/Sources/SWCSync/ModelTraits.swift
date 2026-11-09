import Foundation
import SWCWire

/// A thread's model options as the composer shows them: one control per option
/// the model takes, with the thread's value, and a short summary such as
/// "High · Ultracode · Fast". Names and values follow the desktop's options menu.
public struct ModelTraits: Hashable, Sendable {
  public struct Choice: Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var detail: String?
    public var isDefault: Bool
  }

  public struct Control: Hashable, Sendable, Identifiable {
    public enum Kind: Hashable, Sendable {
      case select(choices: [Choice], current: String?)
      /// Nil when unset: Ultracode then follows the provider's own mode.
      case toggle(current: Bool?)
    }

    public var id: String
    public var label: String
    public var detail: String?
    public var kind: Kind
  }

  /// The selection with the thread's chosen options.
  public var selection: ModelSelection
  public var controls: [Control]

  public init(selection: ModelSelection, descriptors: [ProviderOptionDescriptor]) {
    self.selection = selection
    controls = descriptors.map { descriptor in
      let chosen = selection.option(descriptor.id) ?? descriptor.currentValue
      switch descriptor.kind {
      case let .select(choices):
        let current: String? = if case let .string(value)? = chosen { value } else { choices.first { $0.isDefault == true }?.id }
        let isEffort = Self.effortIds.contains(descriptor.id)
        return Control(
          id: descriptor.id,
          label: descriptor.label,
          detail: descriptor.description,
          kind: .select(
            choices: choices.map { choice in
              Choice(
                id: choice.id,
                label: isEffort ? Self.effortLabel(choice.id, label: choice.label) : choice.label,
                detail: choice.description ?? (isEffort ? Self.effortDetails[Self.normalized(choice.id)] : nil),
                isDefault: choice.isDefault == true
              )
            },
            current: current
          )
        )
      case .boolean:
        let current: Bool? = if case let .bool(value)? = chosen { value } else { nil }
        return Control(id: descriptor.id, label: descriptor.label, detail: descriptor.description, kind: .toggle(current: current))
      }
    }
  }

  public var isEmpty: Bool { controls.isEmpty }

  /// The options in a line, as the desktop's composer chip reads: the effort
  /// (with "Fast" beside it), Ultracode when on, then any other choice.
  public var summary: String {
    var labels: [String] = []
    var effortIndex: Int?
    var fast: Bool?
    for control in controls {
      switch control.kind {
      case let .toggle(current):
        if control.id == "fastMode" { fast = current == true; continue }
        if control.id == "ultracode" {
          if current == true { labels.append("Ultracode") }
          continue
        }
        labels.append("\(control.label) \(current == true ? "On" : "Off")")
      case let .select(choices, current):
        guard let label = choices.first(where: { $0.id == current })?.label, !label.isEmpty else { continue }
        if effortIndex == nil, Self.effortIds.contains(control.id) { effortIndex = labels.count }
        labels.append(label)
      }
    }
    if labels.isEmpty, let fast { return fast ? "Fast" : "Normal" }
    if fast == true {
      if let effortIndex { labels[effortIndex] += " Fast" } else { labels.append("Fast") }
    }
    return labels.joined(separator: " · ")
  }

  /// The selection with one option set, to send with the next message.
  public func setting(_ id: String, to value: ModelOption.Value) -> ModelTraits {
    var next = selection
    var options = next.options ?? []
    if let index = options.firstIndex(where: { $0.id == id }) {
      options[index].value = value
    } else {
      options.append(ModelOption(id: id, value: value))
    }
    next.options = options
    return ModelTraits(selection: next, descriptors: descriptors)
  }

  /// The thread's selection with the options chosen on the phone laid over it.
  public static func merging(_ base: ModelSelection, with chosen: [ModelOption]) -> ModelSelection {
    var next = base
    var options = base.options ?? []
    for option in chosen {
      if let index = options.firstIndex(where: { $0.id == option.id }) { options[index] = option } else { options.append(option) }
    }
    next.options = options.isEmpty ? nil : options
    return next
  }

  /// The options as descriptors again, to rebuild with another selection.
  public var descriptors: [ProviderOptionDescriptor] {
    controls.map { control in
      switch control.kind {
      case let .select(choices, _):
        ProviderOptionDescriptor(
          id: control.id,
          label: control.label,
          description: control.detail,
          kind: .select(choices.map { .init(id: $0.id, label: $0.label, description: $0.detail, isDefault: $0.isDefault) })
        )
      case .toggle:
        ProviderOptionDescriptor(id: control.id, label: control.label, description: control.detail, kind: .boolean)
      }
    }
  }

  static let effortIds: Set<String> = ["reasoningEffort", "reasoning", "effort", "variant", "thinking"]

  private static func normalized(_ value: String) -> String {
    value.lowercased().filter { $0.isLetter || $0.isNumber }
  }

  private static let effortLabels: [String: String] = [
    "off": "Off", "none": "Off", "minimal": "Minimal", "low": "Low", "medium": "Medium",
    "high": "High", "xhigh": "Extra High", "max": "Max", "ultracode": "Ultracode", "ultrathink": "Ultrathink",
  ]

  private static let effortDetails: [String: String] = [
    "off": "No extended reasoning",
    "none": "No extended reasoning",
    "minimal": "Barely reasons, quickest replies",
    "low": "Quick replies with light reasoning",
    "medium": "Balanced speed and depth",
    "high": "Deeper reasoning for harder problems",
    "xhigh": "Extended reasoning for complex work",
    "max": "Longest reasoning, slowest replies",
  ]

  /// A provider label that is only the raw level id ("xhigh") gets its display name.
  static func effortLabel(_ value: String, label: String) -> String {
    normalized(label) == normalized(value) ? (effortLabels[normalized(value)] ?? label) : label
  }
}
