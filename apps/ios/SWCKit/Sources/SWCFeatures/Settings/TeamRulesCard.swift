import SwiftUI
import SWCSync
import Weave

/// What a machine's Team rules limit. Takes no space on a machine without rules.
struct TeamRulesCard: View {
  let rules: TeamRulesInfo?
  /// Names the machine where several could be listed.
  var machineName: String?

  @Environment(\.openURL) private var openURL

  var body: some View {
    if let rules {
      GroupedCard(label: "Team rules", footer: rules.isHold ? nil : "Your own choices come back if the rules are removed.", separatorInset: WeaveSpacing.s4) {
        if rules.isHold {
          WeaveRow("Agents are paused", subtitle: paused(rules)) { EmptyView() } trailing: { EmptyView() }
          ForEach(rules.issues, id: \.self) { issue in
            WeaveRow("Error", subtitle: issue) { EmptyView() } trailing: { EmptyView() }
          }
        } else {
          WeaveRow(rules.setByLabel, subtitle: machineName) { EmptyView() } trailing: { EmptyView() }
          ForEach(rules.rows) { row in
            WeaveRow(row.title, trailingText: row.value)
          }
        }
        contact(rules)
      }
    }
  }

  private func paused(_ rules: TeamRulesInfo) -> String {
    let on = machineName.map { "on \($0)" } ?? "on this machine"
    return "\(rules.setByLabel). The team rules file has an error, so no agent turn can start \(on). Fixing the file resumes agents without a restart."
  }

  /// Rules files are admin text, so only an https address becomes a link.
  @ViewBuilder private func contact(_ rules: TeamRulesInfo) -> some View {
    if let contact = rules.contact {
      if contact.lowercased().hasPrefix("https://"), let url = URL(string: contact) {
        WeaveRow("Why this is locked", subtitle: contact, showsChevron: true, action: { openURL(url) }) { EmptyView() } trailing: { EmptyView() }
      } else {
        WeaveRow("Why this is locked", subtitle: contact) { EmptyView() } trailing: { EmptyView() }
      }
    }
  }
}
