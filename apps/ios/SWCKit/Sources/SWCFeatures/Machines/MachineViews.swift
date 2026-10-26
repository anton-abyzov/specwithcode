import SwiftUI
import SWCSync
import Weave

/// Every paired machine, plus pairing a new one.
struct MachinesView: View {
  @Environment(AppModel.self) private var model
  @Environment(StackNavigator.self) private var nav

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        if model.machines.isEmpty {
          EmptyState(systemName: "laptopcomputer", title: "No machines yet", message: "Open SpecWithCode on your computer and pair this phone.", actionTitle: "Pair a machine") {
            nav.push(.pair)
          }
          .frame(maxWidth: .infinity)
          .padding(.top, WeaveSpacing.s8)
        } else {
          GroupedCard(separatorInset: 56) {
            ForEach(model.machines) { machine in
              WeaveRow(machine.displayName, subtitle: [machine.statusLabel, machine.platform].compactMap { $0 }.joined(separator: " · "), showsChevron: true, action: { nav.push(.machine(machine.id)) }) {
                MachineBadge(status: machine.displayStatus, size: 18)
                  .frame(width: 28)
                  .accessibilityHidden(true)
              } trailing: {
                EmptyView()
              }
            }
            WeaveRow(model.connect == nil ? "Pair a machine" : "Pair with a link or QR code", symbol: "plus", showsChevron: true) { nav.push(.pair) }
          }
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .screenChrome {
      ScreenHeader {
        BackButton()
      } center: {
        HeaderTitle(title: "Machines")
      } trailing: {
        EmptyView()
      }
    }
  }
}

/// One machine: status, address, versions, pairing expiry and actions.
struct MachineDetailView: View {
  let machineId: String

  @Environment(AppModel.self) private var model
  @Environment(StackNavigator.self) private var nav
  @Environment(\.dismiss) private var dismiss
  @State private var confirmRemove = false
  @State private var deviceViewer: DeviceViewerRoute?

  /// Below this many days the pairing gets a warning.
  static let expiryWarningDays = 5

  var body: some View {
    let machine = model.machine(machineId)
    ScrollView {
      if let machine {
        details(machine)
      } else {
        EmptyState(systemName: "laptopcomputer", title: "Machine removed", message: "This phone is no longer paired with it.")
          .frame(maxWidth: .infinity)
          .padding(.top, WeaveSpacing.s8)
      }
    }
    .screenChrome {
      ScreenHeader {
        BackButton()
      } center: {
        HeaderTitle(title: machine?.displayName ?? "Machine")
      } trailing: {
        EmptyView()
      }
    }
    .deviceViewer($deviceViewer)
    .confirmationDialog("Remove \(machine?.displayName ?? "this machine")?", isPresented: $confirmRemove, titleVisibility: .visible) {
      Button("Remove machine", role: .destructive) {
        model.engine.removeMachine(id: machineId)
        dismiss()
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This phone forgets the machine and its pairing. SpecWithCode keeps running on it, and you can pair again later.")
    }
  }

  private func details(_ machine: MachineSummary) -> some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
      hero(machine)
      notice(machine)
      GroupedCard(label: "Details", separatorInset: WeaveSpacing.s4) {
        WeaveRow("Status", stacksTrailing: true) {
          EmptyView()
        } trailing: {
          HStack(spacing: WeaveSpacing.s2) {
            StatusDot(machine.displayStatus).accessibilityHidden(true)
            WeaveRowTrailingText(machine.statusLabel)
          }
        }
        if let address = machine.address {
          WeaveRow("Address", subtitle: address) { EmptyView() } trailing: { EmptyView() }
        }
        if let platform = machine.platform {
          WeaveRow("Platform", trailingText: platform)
        }
        if let version = machine.serverVersion {
          WeaveRow("Server version", trailingText: version)
        }
        if machine.viaConnect {
          WeaveRow("Connection", trailingText: "Your account")
        }
        if machine.hasDirectPairing {
          WeaveRow("Pairing expires", trailingText: Self.expiry(machine.tokenDaysLeft).capitalizedFirst)
        }
      }
      devices(machine)
      GroupedCard(separatorInset: 56) {
        WeaveRow("Reconnect", symbol: "arrow.clockwise") { model.engine.reconnect(machineId: machine.id) }
        if machine.hasDirectPairing || !machine.viaConnect {
          WeaveRow("Pair again", symbol: "qrcode", showsChevron: true) { nav.push(.repair(machine.id)) }
        }
      }
      if !machine.viaConnect {
        GroupedCard(separatorInset: 56) {
          WeaveRow("Remove machine", symbol: "trash", isDestructive: true) { confirmRemove = true }
        }
      }
    }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.bottom, WeaveSpacing.s8)
  }

  /// Simulators and emulators threads opened on this machine.
  @ViewBuilder private func devices(_ machine: MachineSummary) -> some View {
    if let devices = model.devices[machine.id], machine.status.isOnline {
      if let message = devices.support.message {
        GroupedCard(label: "Devices", separatorInset: WeaveSpacing.s4) {
          WeaveRow("Unavailable", subtitle: message) { EmptyView() } trailing: { EmptyView() }
        }
      } else if devices.support == .available {
        GroupedCard(label: "Devices", footer: devices.sessions.isEmpty ? "Agents open simulators and emulators from their threads. They show here while open." : nil) {
          if devices.sessions.isEmpty {
            WeaveRow("No devices open", symbol: "iphone.slash")
          }
          ForEach(devices.sessions) { session in
            WeaveRow(session.name, subtitle: Self.deviceSubtitle(session, machineId: machine.id, model: model), symbol: session.isAndroid ? "candybarphone" : "iphone", showsChevron: true) {
              deviceViewer = DeviceViewerRoute(machineId: machine.id, key: session.id)
            }
            .accessibilityIdentifier("machine.device")
          }
        }
      }
    }
  }

  /// "iOS 26.0 · M4 · Release checklist": the OS, host and the threads looking at it.
  static func deviceSubtitle(_ session: DeviceSessionSummary, machineId: String, model: AppModel) -> String {
    let threads = session.threadIds.compactMap { model.thread(ThreadRef(environmentId: machineId, threadId: $0))?.title }
    return ([session.detail].filter { !$0.isEmpty } + threads).joined(separator: " · ")
  }

  private func hero(_ machine: MachineSummary) -> some View {
    HStack(spacing: WeaveSpacing.s4) {
      MachineBadge(status: machine.displayStatus, systemName: Self.symbol(for: machine), size: 30)
        .frame(width: 64, height: 64)
        .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous))
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(machine.displayName)
          .weaveFont(.title)
          .foregroundStyle(Color.weave.ink)
        if machine.displayName != machine.label {
          Text(machine.label)
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
        }
        Text(machine.statusLabel)
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
      }
      Spacer(minLength: 0)
    }
    .padding(.top, WeaveSpacing.s4)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private func notice(_ machine: MachineSummary) -> some View {
    if machine.needsSignIn {
      Banner("You signed out, so this phone can't reach \(machine.displayName). Sign in again in Settings.", title: "Sign in again", kind: .fail)
    } else if machine.status == .needsRepair, !machine.hasDirectPairing, machine.viaConnect {
      Banner("SpecWithCode Connect couldn't open a connection to \(machine.displayName). Make sure Connect is on in its Settings > Connections.", title: "Can't reach \(machine.displayName)", kind: .fail)
    } else if machine.status == .needsRepair {
      Banner("The pairing for \(machine.label) has expired. Pair again to keep using it from this phone.", title: "Pair again", kind: .fail, actionTitle: "Pair again") { nav.push(.repair(machine.id)) }
    } else if machine.status == .unsupported {
      Banner("Update SpecWithCode on \(machine.label) to use it from this phone.", title: "Update needed", kind: .warn)
    } else if let days = machine.tokenDaysLeft, days < Self.expiryWarningDays {
      Banner("The pairing for \(machine.label) expires \(Self.expiry(days)). Pair again to keep using it from this phone.", title: "Pair again soon", kind: .warn, actionTitle: "Pair again") { nav.push(.repair(machine.id)) }
    } else if machine.isStale {
      Banner("Catching up with \(machine.label). Its projects and threads may be a little behind for a moment.", kind: .info)
    }
  }

  static func expiry(_ days: Int?) -> String {
    guard let days else { return "Unknown" }
    switch days {
    case ..<1: return "today"
    case 1: return "in 1 day"
    default: return "in \(days) days"
    }
  }

  private static func symbol(for machine: MachineSummary) -> String {
    let platform = machine.platform?.lowercased() ?? ""
    if platform.contains("linux") || platform.contains("windows") { return "server.rack" }
    return "laptopcomputer"
  }
}

extension String {
  fileprivate var capitalizedFirst: String { prefix(1).uppercased() + dropFirst() }
}
