import Foundation
import SWCWire

/// Saved provider/model identity, enriched by that machine's catalog when available.
/// Unknown/custom ids stay visible; display names never determine a brand.
public struct ThreadIdentity: Hashable, Sendable {
  public var provider: String
  public var model: String
  public var providerBrand: String?
  public var modelBrand: String?
  public var label: String { "\(provider) · \(model)" }
  public static let unknown = ThreadIdentity(provider: "Unknown provider", model: "Unknown model")

  public init(provider: String, model: String, providerBrand: String? = nil, modelBrand: String? = nil) {
    self.provider = provider
    self.model = model
    self.providerBrand = providerBrand
    self.modelBrand = modelBrand
  }

  public init(selection: ModelSelection, providers: [ServerProviderSummary]) {
    let catalog = providers.first { $0.instanceId == selection.instanceId }
    let id = catalog?.driver ?? selection.instanceId
    let brand = id == "acpRegistry"
      ? Self.registryBrand(catalog?.iconUrl) ?? Self.localAcpBrand(selection.instanceId)
      : Self.providerBrand(id)
    let names = ["claudeAgent": "Claude Code", "codex": "Codex", "githubCopilot": "GitHub Copilot", "copilot": "GitHub Copilot", "gemini": "Gemini CLI", "grok": "Grok", "opencode": "OpenCode", "pi": "Pi", "muse": "Muse"]
    provider = catalog?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
      ?? names[id] ?? selection.instanceId
    model = catalog?.models.first { $0.slug == selection.model || ($0.aliases ?? []).contains(selection.model) }?.name
      ?? Self.modelName(selection.model)
    providerBrand = brand
    modelBrand = Self.modelBrand(selection.model)
  }

  static func registryBrand(_ icon: String?) -> String? {
    guard let icon, let url = URLComponents(string: icon), url.scheme == "https",
      url.host == "cdn.agentclientprotocol.com", url.user == nil, url.password == nil, url.port == nil,
      url.path.hasPrefix("/registry/v1/latest/"), url.path.hasSuffix(".svg") else { return nil }
    let agent = String(url.path.dropFirst("/registry/v1/latest/".count).dropLast(4))
    if agent == "github-copilot" || agent == "github-copilot-cli" { return "copilot" }
    if agent == "droid" || agent == "factory-droid" { return "factory" }
    for (prefix, brand) in [("claude", "claude"), ("codex", "openai"), ("openai", "openai"), ("gemini", "gemini"), ("grok", "grok"), ("cursor", "cursor"), ("qwen", "qwen"), ("kimi", "kimi"), ("mistral", "mistral"), ("kiro", "kiro"), ("deepseek", "deepseek")] {
      if agent == prefix || agent.hasPrefix(prefix + "-") { return brand }
    }
    return ["opencode", "goose", "cline", "auggie", "amp", "junie"].contains(agent) ? agent : nil
  }

  /// DeepSeek Harness is not in the ACP Registry, so a local `dsh` instance has no
  /// icon URL; its instance id is all that names it. Copilot never matches here.
  static func localAcpBrand(_ instanceId: String) -> String? {
    instanceId.lowercased().hasPrefix("acpregistry_deepseek") ? "deepseek" : nil
  }

  public static func providerBrand(_ id: String) -> String? {
    switch id.lowercased() {
    case "claudeagent", "claude", "claude-code", "acpregistry_claude-acp": "claude"
    case "codex", "openai": "openai"
    case "githubcopilot", "githubcopilotacp", "copilot", "acpregistry_github-copilot": "copilot"
    case "gemini", "acpregistry_gemini": "gemini"
    case "grok", "acpregistry_grok": "grok"
    case "opencode", "acpregistry_opencode": "opencode"
    case "pi": "pi"
    case "muse": "meta"
    case "cursor", "antigravity", "ollama": id.lowercased()
    default: nil
    }
  }

  public static func modelBrand(_ slug: String) -> String? {
    let value = slug.lowercased().split(separator: "/").last.map(String.init) ?? slug.lowercased()
    if value.hasPrefix("claude") || value.hasPrefix("opus") || value.hasPrefix("sonnet") || value.hasPrefix("haiku") { return "claude" }
    if value.hasPrefix("gpt-") || value.hasPrefix("o3") || value.hasPrefix("o4") { return "openai" }
    if value.hasPrefix("gemini") { return "gemini" }
    if value.hasPrefix("grok") { return "grok" }
    return nil
  }

  static func modelName(_ slug: String) -> String {
    // Known family/version ids only; a custom model keeps its exact identifier.
    let lower = slug.lowercased()
    for family in ["opus", "sonnet", "haiku"] {
      let prefix = "claude-\(family)-"
      if lower.hasPrefix(prefix) {
        let version = String(slug.dropFirst(prefix.count))
        if version.allSatisfy({ $0.isNumber || $0 == "-" || $0 == "." }) {
          return family.capitalized + " " + version.replacingOccurrences(of: "-", with: ".")
        }
      }
    }
    if lower.hasPrefix("gpt-") { return "GPT-" + slug.dropFirst(4) }
    if lower == "auto" { return "Auto" }
    return slug.isEmpty ? "Unknown model" : slug
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}
