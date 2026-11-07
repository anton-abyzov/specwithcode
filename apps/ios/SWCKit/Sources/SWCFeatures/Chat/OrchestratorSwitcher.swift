import SwiftUI
import SWCSync
import Weave

/// Picks which machine's orchestrator a project on several machines shows.
/// Switching only changes the view: messages then go to that machine's
/// coordinator, and no thread moves.
struct OrchestratorSwitcher: View {
  let current: ProjectRef

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.isBesideCoordinator) private var isBesideCoordinator

  var body: some View {
    let members = Self.choices(model.project(current)?.members ?? [], current: current)
    if members.count > 1 {
      let viewing = members.first { $0.ref == current }
      Menu {
        Section("Coordinator runs on") {
          ForEach(members) { member in
            Button {
              if member.ref != current {
                if isBesideCoordinator { router.chosenCoordinator = member.ref } else { router.open(.project(member.ref)) }
              }
            } label: {
              if member.ref == current {
                Label(Self.title(member, among: members), systemImage: "checkmark")
              } else {
                Text(Self.title(member, among: members))
              }
              Text(Self.detail(member))
            }
            .accessibilityIdentifier("orchestrator.member")
          }
        }
      } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(viewing?.showsMachineOffline == true ? Color.weave.muted : Color.weave.pass)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
          // Long machine names keep both ends ("coordinator…M1").
          Text(viewing?.machineLabel ?? "Machine")
            .font(.weave(.callout, weight: .medium))
            .lineLimit(1)
            .truncationMode(.middle)
            .frame(maxWidth: 120, alignment: .leading)
            .fixedSize(horizontal: false, vertical: true)
          Image(systemName: "chevron.down")
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
        }
        .foregroundStyle(viewing?.showsMachineOffline == true ? Color.weave.muted : Color.weave.ink)
        .padding(.leading, WeaveSpacing.s3)
        .padding(.trailing, WeaveSpacing.s2)
        .frame(height: WeaveSize.minTap)
        .contentShape(Rectangle())
      }
      .menuIndicator(.hidden)
      .buttonStyle(.plain)
      .accessibilityLabel("Coordinator on \(viewing?.machineLabel ?? "this machine")")
      .accessibilityHint("Shows another machine's orchestrator for this project")
      .accessibilityIdentifier("orchestrator.switcher")
    }
  }

  /// One entry per folder on each machine: same-folder copies on one machine
  /// would otherwise list that machine twice, while separate checkouts of the
  /// repository each stay openable. Each entry is the viewed copy, else the
  /// coordinator copy, else a linked copy, else the first copy.
  static func choices(_ members: [ProjectMember], current: ProjectRef) -> [ProjectMember] {
    func rank(_ member: ProjectMember) -> Int {
      if member.ref == current { return 0 }
      if member.isCoordinator { return 1 }
      return member.isLinked ? 2 : 3
    }
    var best: [String: ProjectMember] = [:]
    var order: [String] = []
    for member in members {
      let place = "\(member.ref.environmentId)\n\(member.folder ?? "")"
      if let kept = best[place] {
        if rank(member) < rank(kept) { best[place] = member }
      } else {
        best[place] = member
        order.append(place)
      }
    }
    return order.compactMap { best[$0] }
  }

  /// The machine, and the folder's name when the machine holds several checkouts.
  static func title(_ member: ProjectMember, among choices: [ProjectMember]) -> String {
    let sameMachine = choices.filter { $0.ref.environmentId == member.ref.environmentId }
    guard sameMachine.count > 1, let folder = member.folder?.split(separator: "/").last else { return member.machineLabel }
    return "\(member.machineLabel) · \(folder)"
  }

  /// "Coordinator", "Offline · last seen 2:05 PM", or "Online".
  static func detail(_ member: ProjectMember, now: Date = .now) -> String {
    var parts: [String] = []
    if member.isCoordinator { parts.append("Coordinator") }
    if member.machineOnline {
      if parts.isEmpty { parts.append("Online") }
    } else if member.machineSettling {
      parts.append("Connecting")
    } else if let seen = member.lastSeenAt {
      parts.append("Offline · last seen \(ThreadPlacement.seenTime(seen, now: now, calendar: .current, locale: .current))")
    } else {
      parts.append("Offline")
    }
    return parts.joined(separator: " · ")
  }
}
