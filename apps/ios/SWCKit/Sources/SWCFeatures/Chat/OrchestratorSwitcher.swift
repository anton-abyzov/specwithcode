import SwiftUI
import SWCSync
import Weave

/// Picks which machine's orchestrator a project on several machines shows.
/// Switching only changes the view: messages then go to that machine's
/// coordinator, and no thread moves.
struct OrchestratorSwitcher: View {
  let current: ProjectRef

  @Environment(AppModel.self) private var model

  var body: some View {
    let members = Self.choices(model.project(current)?.members ?? [], current: current)
    if members.count > 1 {
      let rows = members.map { member in
        MenuRow(ref: member.ref, title: Self.title(member, among: members),
                detail: Self.detail(member, approvalCode: model.machine(member.ref.environmentId)?.deviceApprovalCode),
                isUnreached: member.isUnreached)
      }
      let viewing = members.first { $0.ref == current }
      ChoicesMenu(current: current, rows: rows, label: viewing?.machineLabel ?? "Machine", offline: viewing?.showsMachineOffline == true)
        .equatable()
    }
  }

  private nonisolated struct MenuRow: Equatable {
    let ref: ProjectRef
    let title: String
    let detail: String
    let isUnreached: Bool
  }

  private struct ChoicesMenu: View, Equatable {
    let current: ProjectRef
    let rows: [MenuRow]
    let label: String
    let offline: Bool

    @Environment(AppModel.self) private var model
    @Environment(AppRouter.self) private var router
    @Environment(\.isBesideCoordinator) private var isBesideCoordinator

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
      lhs.current == rhs.current && lhs.rows == rhs.rows && lhs.label == rhs.label && lhs.offline == rhs.offline
    }

    var body: some View {
      Menu {
        Section("Coordinator runs on") {
          ForEach(rows, id: \.ref) { member in
            Button {
              if member.ref != current {
                // After the menu closes: the switch replaces the chat that
                // holds this menu, so it must not happen inside its action.
                let beside = isBesideCoordinator
                Task { @MainActor in
                  await Task.yield()
                  if member.isUnreached {
                    router.push(.machine(member.ref.environmentId))
                    return
                  }
                  router.chooseCoordinator(member.ref, besideThread: beside, in: model)
                }
              }
            } label: {
              if member.ref == current {
                Label(member.title, systemImage: "checkmark")
              } else {
                Text(member.title)
              }
              Text(member.detail)
            }
            .accessibilityIdentifier("orchestrator.member")
          }
        }
      } label: {
        HStack(spacing: 6) {
          Circle()
            .fill(offline ? Color.weave.muted : Color.weave.pass)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
          // Long machine names keep both ends ("coordinator…M1").
          Text(label)
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
        .foregroundStyle(offline ? Color.weave.muted : Color.weave.ink)
        .padding(.leading, WeaveSpacing.s3)
        .padding(.trailing, WeaveSpacing.s2)
        .frame(height: WeaveSize.minTap)
        .contentShape(Rectangle())
      }
      .menuIndicator(.hidden)
      .buttonStyle(.plain)
      .accessibilityLabel("Viewing \(label)")
      .accessibilityHint("Shows another machine's coordinator for this project")
      .accessibilityIdentifier("orchestrator.switcher")
    }
  }

  /// One entry per folder on each machine: same-folder copies on one machine
  /// would otherwise list that machine twice, while separate checkouts of the
  /// repository each stay openable. Each entry is the viewed copy, else the
  /// coordinator copy, else a linked copy, else the lowest project id.
  static func choices(_ members: [ProjectMember], current: ProjectRef) -> [ProjectMember] {
    func rank(_ member: ProjectMember) -> Int {
      if member.ref == current { return 0 }
      if member.isCoordinator { return 1 }
      return member.isLinked ? 2 : 3
    }
    var best: [String: ProjectMember] = [:]
    for member in members {
      let place = "\(member.ref.environmentId)\n\(member.folder ?? "")"
      if let kept = best[place], (rank(kept), kept.ref.projectId) <= (rank(member), member.ref.projectId) { continue }
      best[place] = member
    }
    return best.values.sorted { a, b in
      let order = a.machineLabel.localizedStandardCompare(b.machineLabel)
      if order != .orderedSame { return order == .orderedAscending }
      return (a.ref.environmentId, a.folder ?? "", a.ref.projectId) < (b.ref.environmentId, b.folder ?? "", b.ref.projectId)
    }
  }

  /// The machine, and the folder's name when the machine holds several checkouts.
  static func title(_ member: ProjectMember, among choices: [ProjectMember]) -> String {
    let sameMachine = choices.filter { $0.ref.environmentId == member.ref.environmentId }
    guard sameMachine.count > 1, let folder = member.folder?.split(separator: "/").last else { return member.machineLabel }
    return "\(member.machineLabel) · \(folder)"
  }

  /// "Coordinator", "Offline · last seen 2:05 PM", or "Online".
  static func detail(_ member: ProjectMember, approvalCode: String? = nil, now: Date = .now) -> String {
    if member.isUnreached {
      if let approvalCode, !approvalCode.isEmpty {
        return "Waiting for approval · type \(approvalCode) on \(member.machineLabel)"
      }
      return member.machineSettling ? "Connecting" : "Not reached yet"
    }
    var parts: [String] = []
    if member.isCoordinator { parts.append("Coordinator") }
    if member.machineOnline {
      if parts.isEmpty { parts.append("Online") }
    } else if member.machineSettling {
      parts.append("Connecting")
    } else if let seen = member.lastSeenAt {
      parts.append("Offline · last seen \(ThreadPlacement.seenTime(seen.menuMinute, now: now.menuMinute, calendar: .current, locale: .current))")
    } else {
      parts.append("Offline")
    }
    return parts.joined(separator: " · ")
  }
}
