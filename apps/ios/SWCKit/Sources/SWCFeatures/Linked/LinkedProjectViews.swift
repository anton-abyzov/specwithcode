import SwiftUI
import SWCSync
import Weave

// What a project linked across machines shows on the phone: which machine
// coordinates, "<machine> unreachable · last synced <time>", the manual
// takeover after 10 minutes, automatic takeover (standby and re-arm), and the
// one-time prompt to turn on linked machines switched off on this phone.

/// Project settings > Machines: each copy, what it does, and "Take over
/// coordinator here" while the coordinator's machine stays unreachable.
struct LinkedProjectMachinesCard: View {
  let project: ProjectRef

  var body: some View {
    // A new project gets new state, never the previous project's.
    LinkedProjectMachinesCardContent(project: project).id(project)
  }

  static func takeoverHint(_ button: LinkedProjectResolver.TakeoverButton) -> String? {
    switch button {
    case .hidden, .ready: nil
    case let .waiting(minutes): "Available in \(minutes) min"
    case let .unavailable(reason): reason
    }
  }
}

/// The takeover the confirmation names: this copy, from that coordinator.
private struct TakeoverConfirmation {
  let copy: LinkedProjectResolver.Copy
  let coordinator: LinkedProjectResolver.Copy
}

private struct LinkedProjectMachinesCardContent: View {
  @Environment(AppModel.self) private var model
  @State private var state: LinkedProjectState
  @State private var confirming: TakeoverConfirmation?
  @State private var turningOn = false

  init(project: ProjectRef) {
    self._state = State(initialValue: LinkedProjectState(project: project))
  }

  var body: some View {
    let copies = state.copies(in: model)
    if copies.count > 1 {
      let rows = state.rows(copies)
      let coordinator = LinkedProjectResolver.coordinator(copies)
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        GroupedCard(label: "Machines", footer: "Each machine keeps its own copy. One coordinates; the others run workers.") {
          if let line = state.unreachableLine(copies) {
            let switchedOff = coordinator?.machineSwitchedOff == true
            WeaveRow(line, subtitle: switchedOff ? nil : LinkedProjectResolver.coordinatorProblem(copies), symbol: switchedOff ? "power" : "wifi.slash", symbolTint: Color.weave.warn)
              .accessibilityIdentifier("linked.unreachable")
          } else if let problem = LinkedProjectResolver.coordinatorProblem(copies) {
            WeaveRow(problem, symbol: "exclamationmark.triangle", symbolTint: Color.weave.warn)
          }
          ForEach(rows) { row in
            copyRow(row, coordinator: coordinator, awaiting: state.awaitingTakeover(copies))
          }
          switchedOffRow(copies)
        }
        if let message = state.message {
          Banner(message.text, kind: message.isError ? .fail : .pass, onDismiss: { state.message = nil })
        }
        if let standby = state.standby(copies) {
          standbyCard(standby)
        }
      }
      .task { await state.follow(model: model) }
      .confirmationDialog(
        "Take over the coordinator on \(confirming?.copy.machineLabel ?? "this machine")?",
        isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
        titleVisibility: .visible
      ) {
        Button("Take over") {
          if let confirmed = confirming { Task { await state.takeOver(at: confirmed.copy, from: confirmed.coordinator, model: model) } }
          confirming = nil
        }
        Button("Cancel", role: .cancel) { confirming = nil }
      } message: {
        Text(LinkedProjectResolver.takeoverConfirmation(coordinator: confirming?.coordinator.machineLabel ?? "The coordinator's machine"))
      }
    }
  }

  @ViewBuilder private func copyRow(_ row: LinkedProjectResolver.Row, coordinator: LinkedProjectResolver.Copy?, awaiting: Bool) -> some View {
    let title = row.copy.machineLabel + (row.isStandby ? " · Standby" : "")
    let subtitle = [LinkedProjectResolver.roleText(row.role), row.note].compactMap { $0 }.joined(separator: "\n")
    VStack(alignment: .leading, spacing: 0) {
      WeaveRow(title, subtitle: subtitle, symbol: row.role == .coordinator ? "star.circle" : "laptopcomputer",
               symbolTint: row.copy.machineOnline ? Color.weave.pass : Color.weave.muted,
               trailingText: row.copy.machineSwitchedOff ? "Off" : row.copy.machineOnline ? "Online" : row.copy.machineSettled ? "Offline" : "Connecting")
      if row.takeover != .hidden {
        VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
          WeaveButton("Take over coordinator here", systemImage: "arrow.triangle.swap", kind: .secondary, isLoading: state.busy) {
            if let coordinator { confirming = TakeoverConfirmation(copy: row.copy, coordinator: coordinator) }
          }
          .disabled(row.takeover != .ready || state.busy || awaiting)
          .accessibilityIdentifier("linked.takeover")
          if let hint = LinkedProjectMachinesCard.takeoverHint(row.takeover) {
            Text(hint)
              .font(.weave(.caption))
              .foregroundStyle(Color.weave.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.leading, 56)
        .padding(.trailing, WeaveSpacing.s4)
        .padding(.bottom, WeaveSpacing.s3)
      }
    }
  }

  @ViewBuilder private func switchedOffRow(_ copies: [LinkedProjectResolver.Copy]) -> some View {
    let off = LinkedProjectResolver.switchedOffMachines(copies)
    if !off.isEmpty {
      WeaveRow(off.count == 1 ? "\(off[0].machineLabel) is switched off on this phone" : "\(off.count) linked machines are switched off",
               symbol: "power", symbolTint: Color.weave.muted, trailingText: turningOn ? "Turning on" : "Turn all on") {
        guard !turningOn else { return }
        turningOn = true
        Task {
          if let failure = await LinkedMachinesPrompt.turnOn(off, model: model) { state.message = (failure, true) }
          turningOn = false
        }
      }
      .accessibilityIdentifier("linked.turn-on")
    }
  }

  private func standbyCard(_ standby: LinkedProjectResolver.Standby) -> some View {
    GroupedCard(label: standby.title, footer: "Another copy can take over this coordinator when its machine stops answering. Set this up in the SpecWithCode desktop app.") {
      WeaveRow("Take over automatically on", symbol: "arrow.triangle.2.circlepath", trailingText: standby.standbyMachine ?? "Off")
      if let after = standby.after {
        WeaveRow("After", symbol: "timer", trailingText: after)
      }
      if let armNext = standby.armNext {
        WeaveRow(armNext, symbol: "list.number")
      }
      if let rearm = standby.rearmStatus {
        WeaveRow(rearm, symbol: "shield.lefthalf.filled", symbolTint: Color.weave.warn)
          .accessibilityIdentifier("linked.rearm-status")
      }
      if let tookOver = standby.tookOver {
        WeaveRow(tookOver, symbol: "clock.arrow.circlepath")
      }
    }
    .accessibilityIdentifier("linked.standby")
  }
}

/// "<machine> unreachable · last synced <time>" above a linked project's
/// threads while its coordinator's machine is unreachable.
struct LinkedCoordinatorBanner: View {
  let project: ProjectRef

  var body: some View {
    // A new project gets new state, never the previous project's.
    LinkedCoordinatorBannerContent(project: project).id(project)
  }
}

private struct LinkedCoordinatorBannerContent: View {
  let project: ProjectRef

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var state: LinkedProjectState

  init(project: ProjectRef) {
    self.project = project
    self._state = State(initialValue: LinkedProjectState(project: project))
  }

  var body: some View {
    let copies = state.copies(in: model)
    if let line = state.unreachableLine(copies) {
      Banner(line, kind: .warn, actionTitle: "Machines") { router.sheet = .projectSettings(LinkedProjectState.settingsTarget(project, in: model)) }
        .accessibilityIdentifier("linked.banner")
        .task { await state.follow(model: model) }
    }
  }
}

/// Asks once per linked project to turn on its machines that are switched
/// off on this phone, when that project opens. The project is remembered
/// only once the person answers; until then the check runs again as the
/// machines' project lists arrive.
struct LinkedMachinesPrompt: ViewModifier {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var asking: Ask?

  struct Ask: Identifiable, Equatable {
    let id: String
    let project: String
    let machines: [LinkedProjectResolver.Copy]
  }

  func body(content: Content) -> some View {
    let ask = pendingAsk
    content
      .task(id: ask) { if asking == nil, let ask { asking = ask } }
      .alert(
        asking.map { LinkedProjectResolver.switchedOffPromptTitle($0.machines) } ?? "",
        isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }),
        presenting: asking
      ) { ask in
        Button("Turn on") {
          LinkedMachinesPromptMemory.remember(ask.id)
          Task {
            if let failure = await Self.turnOn(ask.machines, model: model) {
              router.toast = WeaveToastMessage(failure, kind: .fail)
            }
          }
        }
        Button("Not now", role: .cancel) { LinkedMachinesPromptMemory.remember(ask.id) }
      } message: { ask in
        Text(LinkedProjectResolver.switchedOffPromptMessage(ask.machines, project: ask.project))
      }
  }

  /// The project open on the main stack: its chat at the root, or its overview or chat on top.
  private var openedProject: ProjectRef? {
    switch router.main.path.last {
    case let .overview(ref)?, let .chat(.project(ref))?: return ref
    default: break
    }
    if case let .project(ref)? = router.root { return ref }
    return nil
  }

  /// The prompt the open project needs now, or nil. Read in `body`, so it is
  /// worked out again when the machines or their projects change.
  private var pendingAsk: Ask? {
    guard let ref = openedProject, let engine = model.engine as? LinkedProjectEngine else { return nil }
    let copies = engine.linkedCopies(of: ref, in: model)
    let key = LinkedMachinesPromptMemory.projectKey(copies, fallback: ref)
    guard LinkedProjectResolver.shouldPromptSwitchedOff(projectKey: key, copies: copies, asked: LinkedMachinesPromptMemory.asked()) else { return nil }
    return Ask(id: key, project: model.project(ref)?.title ?? "this project", machines: LinkedProjectResolver.switchedOffMachines(copies))
  }

  /// Turns each machine's connection back on, through the same switch as
  /// Machines. Returns what went wrong, or nil.
  static func turnOn(_ machines: [LinkedProjectResolver.Copy], model: AppModel) async -> String? {
    var failed: [String] = []
    var reason: String?
    for machine in machines {
      do {
        try await model.engine.setConnectionEnabled(true, machineId: machine.ref.environmentId)
      } catch {
        failed.append(machine.machineLabel)
        reason = reason ?? error.localizedDescription
      }
    }
    guard !failed.isEmpty else { return nil }
    let names = failed.joined(separator: ", ")
    return "Could not turn on \(names)." + (reason.map { $0.isEmpty ? "" : " \($0)" } ?? "")
  }
}

extension View {
  /// The one-time prompt to turn on a linked project's switched-off machines.
  func linkedMachinesPrompt() -> some View { modifier(LinkedMachinesPrompt()) }
}
