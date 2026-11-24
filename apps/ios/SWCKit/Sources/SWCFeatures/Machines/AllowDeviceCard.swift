import SwiftUI
import SWCSync
import Weave

/// "Allow a device": on a machine that already approved this phone, lets the
/// person type the code another device shows. The phone is never sent that
/// code, and what is typed stays in this view: it is not logged or stored.
struct AllowDeviceCard: ViewModifier {
  let machine: MachineSummary

  @Environment(AppModel.self) private var model
  /// Nil until the machine says this phone may approve; the card shows nothing then.
  @State private var waiting: [WaitingDevice]?
  @State private var code = ""
  @State private var sending = false
  @State private var outcome: AllowDeviceOutcome?
  /// The last refresh got no answer, though the machine's socket may still be up.
  @State private var unreachable = false

  private static let refreshInterval: Duration = .seconds(5)

  private struct Watch: Hashable {
    let machineId: String
    let canAsk: Bool
  }

  func body(content: Content) -> some View {
    // A modifier, so the page's stack gets no gap while there is nothing to show.
    VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
      if machine.deviceApprovalCode == nil, let waiting { card(waiting) }
      content
    }
    .task(id: Watch(machineId: machine.id, canAsk: machine.status.isOnline && machine.deviceApprovalCode == nil)) {
      guard machine.status.isOnline, machine.deviceApprovalCode == nil else { return }
      while !Task.isCancelled {
        guard await refresh() else { return }
        try? await Task.sleep(for: Self.refreshInterval)
      }
    }
    .onDisappear {
      code = ""
      outcome = nil
    }
  }

  private func card(_ devices: [WaitingDevice]) -> some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s3) {
      GroupedCard(label: "Allow a device", separatorInset: WeaveSpacing.s4) {
        if devices.isEmpty {
          WeaveRow("No device is waiting", subtitle: "When a device asks, type the code it shows.") { EmptyView() } trailing: { EmptyView() }
        }
        ForEach(devices) { device in
          WeaveRow(device.label, subtitle: device.shortId.map { "ID \($0)" }) { EmptyView() } trailing: { EmptyView() }
            .accessibilityIdentifier("allowDevice.waiting")
        }
      }
      // The result sits above the box and Allow inside it, so the keyboard covers neither.
      if !machine.status.isOnline {
        Banner("Reconnect to \(machine.displayName) to allow a device.", kind: .info)
      } else if let outcome {
        Banner(outcome.message(machine: machine.displayName), kind: outcome.isSuccess ? .pass : .warn)
          .accessibilityIdentifier("allowDevice.result")
      } else if unreachable {
        Banner(AllowDeviceOutcome.unreachable.message(machine: machine.displayName), kind: .warn)
          .accessibilityIdentifier("allowDevice.result")
      }
      WeaveTextField("6-character code", text: $code, label: "Code shown on the other device", onSubmit: submit) {
        EmptyView()
      } trailing: {
        WeaveButton("Allow", isLoading: sending, action: submit)
          .disabled(!canSubmit(devices))
          .accessibilityIdentifier("allowDevice.allow")
      }
      .allowDeviceCodeInput()
      .privacySensitive()
      .disabled(!machine.status.isOnline || sending)
      // A filter inside a custom Binding leaves the raw text in the field.
      .onChange(of: code) { before, typed in
        let clean = AllowDeviceCode.normalized(typed)
        if clean != typed {
          code = clean
        } else if !clean.isEmpty, clean != AllowDeviceCode.normalized(before) {
          outcome = nil
        }
      }
    }
  }

  private func canSubmit(_ devices: [WaitingDevice]) -> Bool {
    machine.status.isOnline && !sending && !devices.isEmpty && code.count == AllowDeviceCode.length
  }

  private func submit() {
    guard let waiting, canSubmit(waiting) else { return }
    let typed = code
    sending = true
    Task {
      let result = await model.engine.allowDevice(code: typed, machineId: machine.id)
      sending = false
      outcome = result
      if result.isSuccess { code = "" }
      if result == .noLongerAllowed {
        hide()
      } else {
        await refresh()
      }
    }
  }

  /// False when this phone itself waits on the machine: asking again would renew that wait.
  @discardableResult
  private func refresh() async -> Bool {
    let listing = await model.engine.allowDeviceListing(machineId: machine.id)
    unreachable = listing == .unreachable
    switch listing {
    case .unavailable: hide()
    case .waitingHere:
      hide()
      return false
    case .unreachable: break
    case let .ready(devices): waiting = devices
    }
    return true
  }

  private func hide() {
    waiting = nil
    code = ""
    outcome = nil
  }
}

extension View {
  /// Puts "Allow a device" above this view when this phone may approve there.
  func allowDeviceCard(for machine: MachineSummary) -> some View {
    modifier(AllowDeviceCard(machine: machine)).id(machine.id)
  }
}

private extension View {
  /// Capitals only, and never the system's one-time-code autofill: this code
  /// comes from another device's screen, typed by the person.
  @ViewBuilder func allowDeviceCodeInput() -> some View {
    #if os(iOS)
    self
      .textInputAutocapitalization(.characters)
      .autocorrectionDisabled()
      .textContentType(nil)
      .keyboardType(.asciiCapable)
    #else
    self
    #endif
  }
}
