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

  var body: some View {
    let members = Self.choices(model.project(current)?.members ?? [], current: current)
    if members.count > 1 {
      let viewing = members.first { $0.ref == current }
      Menu {
        Section("Orchestrator") {
          ForEach(members) { member in
            Button {
              if member.ref != current { router.open(.project(member.ref)) }
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
        HStack(spacing: 4) {
          Text(viewing?.machineLabel ?? "Machine")
            .font(.weave(.callout))
            .lineLimit(1)
          Image(systemName: "chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .accessibilityHidden(true)
        }
        .foregroundStyle(viewing?.machineOnline == false ? Color.weave.muted : Color.weave.ink)
        .padding(.horizontal, WeaveSpacing.s3)
        .frame(height: WeaveSize.minTap)
        .contentShape(Capsule())
        .weaveGlass(in: Capsule(), interactive: true)
      }
      .menuIndicator(.hidden)
      .buttonStyle(.plain)
      .accessibilityLabel("Orchestrator on \(viewing?.machineLabel ?? "this machine")")
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
    } else if let seen = member.lastSeenAt {
      parts.append("Offline · last seen \(ThreadPlacement.seenTime(seen, now: now, calendar: .current, locale: .current))")
    } else {
      parts.append("Offline")
    }
    return parts.joined(separator: " · ")
  }
}
