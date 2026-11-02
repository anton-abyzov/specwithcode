import SWCWire

enum FixtureTeamRules {
  static func apply(to machines: [MachineSummary], limited: String, broken: String, refusing: String) -> [MachineSummary] {
    machines.map { machine in
      var machine = machine
      switch machine.id {
      case limited:
        machine.teamRules = TeamRulesInfo(TeamRulesSummary(
          owner: "Acme IT",
          contact: "https://acme.example/ai-policy",
          ceiling: .autoAcceptEdits,
          providers: ["claudeAgent", "codex"],
          ownsProviderLaunch: true,
          reach: .init(connect: false, machines: "same-rules"),
          tools: .init(chrome: false, computerUse: false)
        ))
      case broken:
        machine.teamRules = TeamRulesInfo(TeamRulesSummary(
          status: "hold",
          owner: "Acme IT",
          contact: "https://acme.example/ai-policy",
          issues: ["agents.ceiling must be one of approval-required, auto-accept-edits, auto, full-access."]
        ))
      case refusing:
        machine.teamRulesRefusal = "Acme IT's rules turn off phones on this machine. See https://acme.example/ai-policy."
      default:
        break
      }
      return machine
    }
  }
}
