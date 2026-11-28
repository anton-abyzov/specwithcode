import SwiftUI
import SWCSync
import Weave

struct SidebarMachineMenu: View, Equatable {
  nonisolated struct Row: Identifiable, Equatable {
    let id: String
    let name: String
    let status: WeaveStatus
    let statusLabel: String
  }

  let rows: [Row]
  let selectedId: String?
  @Environment(AppRouter.self) private var router

  nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.rows == rhs.rows && lhs.selectedId == rhs.selectedId
  }

  static func rows(_ machines: [MachineSummary], now: Date = .now) -> [Row] {
    machines.map { machine in
      var machine = machine
      machine.checkedAt = machine.checkedAt?.menuMinute
      return Row(id: machine.id, name: machine.displayName, status: machine.displayStatus, statusLabel: machine.statusLabel(now: now.menuMinute))
    }.sorted { a, b in
      let order = a.name.localizedStandardCompare(b.name)
      return order == .orderedSame ? a.id < b.id : order == .orderedAscending
    }
  }

  var body: some View {
    let current = rows.first { $0.id == selectedId }
    return Menu {
      Picker("Machine", selection: Binding(get: { selectedId }, set: { id in withAnimation(.snappy) { router.sidebarMachine = id } })) {
        Text("All machines").tag(String?.none)
        ForEach(rows) { machine in
          Text("\(machine.name) · \(machine.statusLabel)").tag(String?.some(machine.id))
        }
      }
    } label: {
      HStack(spacing: WeaveSpacing.s1) {
        if let current { MachineBadge(status: current.status, size: 15) }
        Text(current?.name ?? "All machines")
          .font(.weave(.callout, weight: .medium))
          .lineLimit(1)
        Image(systemName: "chevron.down")
          .font(.system(size: 11, weight: .semibold))
          .accessibilityHidden(true)
      }
      .foregroundStyle(Color.weave.ink)
      .padding(.horizontal, WeaveSpacing.s3)
      .frame(minHeight: WeaveSize.minTap)
      .background(Color.weave.line, in: Capsule())
      .contentShape(Capsule())
    }
    .accessibilityLabel("Machine")
    .accessibilityValue(current.map { "\($0.name), \($0.statusLabel)" } ?? "All machines")
    .accessibilityIdentifier("sidebar.machine-menu")
  }
}
