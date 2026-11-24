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
  /// The provider's logo asset ("claude"), when it has one.
  public var brand: String?
  public var slug: String
  /// The model's short name ("Opus 5.5").
  public var name: String
  public var aliases: [String]
  public var descriptors: [ProviderOptionDescriptor]

  public init(instanceId: String, provider: String, brand: String? = nil, slug: String, name: String, aliases: [String] = [], descriptors: [ProviderOptionDescriptor] = []) {
    self.instanceId = instanceId
    self.provider = provider
    self.brand = brand
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
    let model = Self.baseSlug(selection.model)
    return instanceId == selection.instanceId && (Self.baseSlug(slug) == model || aliases.map(Self.baseSlug).contains(model))
  }

  /// Whether two selections name the same model, options aside.
  public static func sameModel(_ a: ModelSelection, _ b: ModelSelection) -> Bool {
    a.instanceId == b.instanceId && baseSlug(a.model) == baseSlug(b.model)
  }

  /// Whether two selections are the same model with the same options, in any order.
  public static func sameSelection(_ a: ModelSelection?, _ b: ModelSelection?) -> Bool {
    guard let a, let b else { return a == nil && b == nil }
    let sorted = { (s: ModelSelection) in (s.options ?? []).sorted { $0.id < $1.id } }
    return a.instanceId == b.instanceId && a.model == b.model && sorted(a) == sorted(b)
  }

  /// A slug without a variant suffix such as "[1m]" (the context window).
  static func baseSlug(_ slug: String) -> String {
    guard slug.hasSuffix("]"), let open = slug.lastIndex(of: "[") else { return slug }
    return String(slug[..<open])
  }

  /// The models a thread may switch to: every model of each provider on its
  /// machine that is enabled, installed and ready, plus the thread's own
  /// model even when its provider is not ready, so the menu can show it.
  public static func available(providers: [ServerProviderSummary], current: ModelSelection) -> [ModelChoice] {
    var choices: [ModelChoice] = []
    let identities = Dictionary(providers.map { ($0.instanceId, ThreadIdentity(selection: ModelSelection(instanceId: $0.instanceId, model: ""), providers: [$0])) }, uniquingKeysWith: { a, _ in a })
    let harness = identities.mapValues(\.provider)
    for provider in providers {
      let ready = provider.enabled && provider.installed && provider.status == "ready"
      // Two instances of one harness ("Claude Code" twice) are told apart by
      // the name the person gave each, else by their id.
      var name = harness[provider.instanceId] ?? provider.instanceId
      if harness.values.filter({ $0 == name }).count > 1 {
        let given = provider.displayName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        name = given.isEmpty || given == name ? "\(name) (\(provider.instanceId))" : given
      }
      for model in provider.models {
        let choice = ModelChoice(
          instanceId: provider.instanceId,
          provider: name,
          brand: identities[provider.instanceId]?.providerBrand,
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
