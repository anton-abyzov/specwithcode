import SwiftUI
import SWCSync
import Weave

/// "Allow this phone": while machines wait to let this phone in, every screen
/// shows each one's current code, so the owner never has to find the one chat
/// that holds it (1447). Hide folds it to one row until a machine that was not
/// waiting then starts waiting, or 30 days pass.
///
/// On a chat or machine page whose own machine is waiting, that screen already
/// shows its code (1406, 1408), so the block starts folded there without
/// writing a Hide; Show codes still opens it.
struct ApprovalCodesBlock: View {
  enum Placement { case screen, sheet }

  let placement: Placement
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var confirmStop = false
  /// The machines listed when Stop asking was tapped; only these are paused.
  @State private var stopIds: [String] = []
  /// Show codes tapped on a screen that folds the block by itself.
  @State private var openedByTap = false
  @State private var stopping = false

  var body: some View {
    let waiting = model.machinesAwaitingApproval()
    if !waiting.isEmpty {
      content(waiting)
        .onAppear { applyLaunchState(waiting) }
        // The last machine left while the question was up: never ask later unprompted.
        .onDisappear { confirmStop = false; stopIds = [] }
        .alert(ApprovalBlock.stopAskingQuestion, isPresented: $confirmStop) {
          Button(ApprovalBlock.stopAskingTitle, role: .destructive) { stopAsking(stopIds) }
          Button("Cancel", role: .cancel) { stopIds = [] }
        } message: {
          Text(ApprovalBlock.stopAskingMessage)
        }
    }
  }

  @ViewBuilder private func content(_ waiting: [MachineSummary]) -> some View {
    let ids = waiting.map(\.id)
    let hidden = ApprovalBlock.isCollapsed(waiting: ids, hide: hide, now: Date())
    Group {
      if hidden || (!openedByTap && screenShowsCodes(of: Set(ids))) {
        collapsed(count: waiting.count)
      } else {
        expanded(waiting)
      }
    }
    .frame(maxWidth: .infinity)
    .background(Color.weave.irisTint.ignoresSafeArea(edges: placement == .screen ? .top : []))
    .overlay(alignment: .bottom) {
      Rectangle().fill(Color.weave.line).frame(height: WeaveSize.hairline)
    }
    .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    .accessibilityIdentifier("approval-block")
  }

  // MARK: Folded

  private func collapsed(count: Int) -> some View {
    Button(action: show) {
      HStack(spacing: WeaveSpacing.s2) {
        Image(systemName: "key.horizontal")
          .font(.weave(.callout))
          .accessibilityHidden(true)
        Text(ApprovalBlock.collapsedLine(count: count))
          .font(.weave(.callout, weight: .semibold))
          .multilineTextAlignment(.leading)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: WeaveSpacing.s2)
        Image(systemName: "chevron.down")
          .font(.weave(.caption))
          .accessibilityHidden(true)
      }
      .foregroundStyle(Color.weave.irisStrong)
      .padding(.horizontal, WeaveSpacing.gutter)
      .frame(maxWidth: .infinity, minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityHint("Shows each machine's code for this phone")
    .accessibilityIdentifier("approval-block.show")
  }

  // MARK: Open

  private func expanded(_ waiting: [MachineSummary]) -> some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s2) {
        VStack(alignment: .leading, spacing: 2) {
          Text(ApprovalBlock.title(for: waiting))
            .font(.weave(.headline, weight: .semibold))
            .foregroundStyle(Color.weave.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
          Text(ApprovalBlock.subtitle)
            .weaveFont(.caption)
            .foregroundStyle(Color.weave.muted)
        }
        Spacer(minLength: WeaveSpacing.s2)
        Button("Hide") { hideBlock(waiting) }
          .font(.weave(.callout, weight: .semibold))
          .foregroundStyle(Color.weave.irisStrong)
          .frame(minWidth: WeaveSize.minTap, minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
          .buttonStyle(.plain)
          .accessibilityHint("Folds the codes into one row")
          .accessibilityIdentifier("approval-block.hide")
      }
      VStack(spacing: 0) {
        ForEach(waiting) { machine in
          if let code = machine.deviceApprovalCode { codeRow(machine, code: code) }
        }
      }
      .background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous))
      HStack(spacing: WeaveSpacing.s2) {
        if let line = model.thisPhoneLine {
          Text(line)
            .weaveFont(.caption)
            .foregroundStyle(Color.weave.muted)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("approval-block.this-phone")
        }
        Spacer(minLength: WeaveSpacing.s2)
        Button(ApprovalBlock.stopAskingTitle) { askToStop(waiting) }
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .frame(minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
          .buttonStyle(.plain)
          .disabled(stopping)
          .accessibilityHint("Pauses this phone on every machine listed")
          .accessibilityIdentifier("approval-block.stop")
      }
    }
    .padding(.horizontal, WeaveSpacing.gutter)
    .padding(.vertical, WeaveSpacing.s2)
  }

  /// "linux-mini  BWQ35F" copying on tap, like the chat's rows (1406).
  private func codeRow(_ machine: MachineSummary, code: String) -> some View {
    Button { WeaveClipboard.copyAnnounced(code) } label: {
      HStack(spacing: WeaveSpacing.s2) {
        VStack(alignment: .leading, spacing: 2) {
          Text(machine.displayName)
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.ink)
            .lineLimit(2)
          if !machine.approvalReachable {
            Text(machine.approvalUnreachableNote)
              .weaveFont(.footnote)
              .foregroundStyle(Color.weave.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Spacer(minLength: WeaveSpacing.s2)
        Text(code)
          .font(Font.weave(.headline).monospaced())
          .tracking(2)
          .foregroundStyle(machine.approvalReachable ? Color.weave.ink : Color.weave.muted)
        Image(systemName: "doc.on.doc")
          .font(.weave(.caption))
          .foregroundStyle(Color.weave.muted)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, WeaveSpacing.s3)
      .frame(maxWidth: .infinity, minHeight: WeaveSize.minTap)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(machine.displayName) code \(code.map(String.init).joined(separator: " ")). Copy\(machine.approvalReachable ? "" : ". \(machine.approvalUnreachableNote)")")
    .accessibilityIdentifier("approval-block.code.\(machine.id)")
  }

  // MARK: State

  private var hide: ApprovalBlockHide? { router.approvalHides.load(phone: model.thisPhoneShortID) }

  /// True when the screen under the block is a chat or machine page of a
  /// waiting machine, which shows its code itself. A sheet or the open drawer
  /// covers that screen, so the block stays open there.
  private func screenShowsCodes(of waiting: Set<String>) -> Bool {
    guard placement == .screen, !router.isDrawerOpen else { return false }
    let shown: String?
    switch router.main.path.last {
    case let .chat(target): shown = target.environmentId
    case let .machine(id): shown = id
    case nil: shown = router.landing(in: model)?.environmentId
    default: shown = nil
    }
    return shown.map(waiting.contains) ?? false
  }

  private func hideBlock(_ waiting: [MachineSummary]) {
    let phone = model.thisPhoneShortID
    let record = ApprovalBlock.hide(waiting: waiting.map(\.id), previous: router.approvalHides.load(phone: phone), now: Date())
    withAnimation(.easeInOut(duration: 0.2)) {
      openedByTap = false
      router.approvalHides.save(record, phone: phone)
    }
  }

  private func show() {
    withAnimation(.easeInOut(duration: 0.2)) {
      openedByTap = true
      if router.approvalHides.load(phone: model.thisPhoneShortID) != nil {
        router.approvalHides.save(nil, phone: model.thisPhoneShortID)
      }
    }
  }

  private func askToStop(_ waiting: [MachineSummary]) {
    stopIds = waiting.map(\.id)
    confirmStop = true
  }

  /// Pauses this phone on each listed machine with the machine page's
  /// Disconnect, so each one keeps offering Reconnect.
  private func stopAsking(_ ids: [String]) {
    stopIds = []
    guard !ids.isEmpty else { return }
    stopping = true
    Task {
      defer { stopping = false }
      for id in ids {
        do { try await model.engine.setConnectionEnabled(false, machineId: id) }
        catch { router.showError(error) }
      }
    }
  }

  private func applyLaunchState(_ waiting: [MachineSummary]) {
    guard placement == .screen, let state = router.approvalLaunchState else { return }
    router.approvalLaunchState = nil
    switch state {
    case .hidden: hideBlock(waiting)
    case .confirm: askToStop(waiting)
    }
  }
}
