import Foundation
import SWCWire

/// A model the thread can switch to from the composer's options menu, from its
/// machine's provider catalog. Picking one sends it with the next message,
/// which the machine runs on that model (another provider takes the
/// conversation over through a handoff, as on the desktop).
public struct ModelChoice: Hashable, Sendable, Identifiable {
  public var id: String { "\(instanceId)/\(slug)" }
  public var instanceId: String
  /// The provider's name as the thread header shows it ("Claude Code").
  public var provider: String
  public var slug: String
  /// The model's short name ("Opus 5.5").
  public var name: String
  public var aliases: [String]
  public var descriptors: [ProviderOptionDescriptor]

  public init(instanceId: String, provider: String, slug: String, name: String, aliases: [String] = [], descriptors: [ProviderOptionDescriptor] = []) {
    self.instanceId = instanceId
    self.provider = provider
    self.slug = slug
    self.name = name
    self.aliases = aliases
    self.descriptors = descriptors
  }

  /// The selection to send for this model. Options never carry over from
  /// another model: they start from this model's machine defaults.
  public var selection: ModelSelection { ModelSelection(instanceId: instanceId, model: slug) }

  /// This model's options for the menu, or nil when it takes none.
  public func traits(for selection: ModelSelection) -> ModelTraits? {
    descriptors.isEmpty ? nil : ModelTraits(selection: selection, descriptors: descriptors)
  }

  /// Whether this is the model a selection names (by slug or alias).
  public func matches(_ selection: ModelSelection) -> Bool {
    instanceId == selection.instanceId && (slug == selection.model || aliases.contains(selection.model))
  }

  /// The models a thread may switch to: every model of each provider on its
  /// machine that is enabled, installed and ready, plus the thread's own
  /// model even when its provider is not ready, so the menu can show it.
  public static func available(providers: [ServerProviderSummary], current: ModelSelection) -> [ModelChoice] {
    var choices: [ModelChoice] = []
    for provider in providers {
      let ready = provider.enabled && provider.installed && provider.status == "ready"
      let name = ThreadIdentity(selection: ModelSelection(instanceId: provider.instanceId, model: ""), providers: [provider]).provider
      for model in provider.models {
        let choice = ModelChoice(
          instanceId: provider.instanceId,
          provider: name,
          slug: model.slug,
          name: ThreadIdentity(selection: ModelSelection(instanceId: provider.instanceId, model: model.slug), providers: [provider]).model,
          aliases: model.aliases ?? [],
          descriptors: model.optionDescriptors
        )
        guard ready || choice.matches(current) else { continue }
        choices.append(choice)
      }
    }
    return choices
  }

  /// The choices grouped by provider, in catalog order.
  public static func grouped(_ choices: [ModelChoice]) -> [(provider: String, instanceId: String, models: [ModelChoice])] {
    var groups: [(provider: String, instanceId: String, models: [ModelChoice])] = []
    for choice in choices {
      if let index = groups.firstIndex(where: { $0.instanceId == choice.instanceId }) {
        groups[index].models.append(choice)
      } else {
        groups.append((choice.provider, choice.instanceId, [choice]))
      }
    }
    return groups
  }
}
