import SwiftUI
import SWCSync
import Weave

/// App settings: machines, per-machine defaults, appearance and about.
struct GlobalSettingsSheet: View {
  @State private var nav = StackNavigator()

  var body: some View {
    @Bindable var nav = nav
    NavigationStack(path: $nav.path) {
      GlobalSettingsRoot()
        .navigationDestination(for: Route.self) { RouteDestination(route: $0) }
    }
    .environment(nav)
  }
}

private struct GlobalSettingsRoot: View {
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(StackNavigator.self) private var nav
  @Environment(\.openURL) private var openURL
  @AppStorage(AppDefaults.deviceLabel) private var deviceLabel = ""
  @AppStorage(AppDefaults.dictationLanguage) private var dictationLanguage = ""

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        if let connect = model.connect {
          ConnectAccountCard(state: connect)
          if connect.isSignedIn { ConnectPhonesCard(state: connect) }
        }
        machines
        if !model.machines.isEmpty { MachineDefaultsCard() }
        ForEach(machinesWithRules) { machine in
          TeamRulesCard(rules: machine.teamRules, machineName: model.machines.count > 1 ? machine.displayName : nil)
        }
        appearance
        replies
        dictationSection
        deviceName
        about
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .screenChrome {
      ScreenHeader {
        CloseButton()
      } center: {
        HeaderTitle(title: "Settings")
      } trailing: {
        EmptyView()
      }
    }
  }

  private var machinesWithRules: [MachineSummary] { model.machines.filter { $0.teamRules != nil } }

  private var machines: some View {
    GroupedCard(label: "Machines", separatorInset: 56) {
      ForEach(model.machines) { machine in
        WeaveRow(machine.displayName, subtitle: machine.statusLabel, showsChevron: true, action: { nav.push(.machine(machine.id)) }) {
          MachineBadge(status: machine.displayStatus, size: 18)
            .frame(width: 28)
            .accessibilityHidden(true)
        } trailing: {
          EmptyView()
        }
      }
      WeaveRow(model.connect == nil ? "Pair a machine" : "Add a device or machine", symbol: "plus", showsChevron: true) { nav.push(model.connect == nil ? .pair : .addDevice) }
    }
  }

  private var appearance: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      FieldLabel("Appearance")
      AppearancePicker(selection: Binding(
        get: { (router.appearanceOverride ?? model.appearance).rawValue },
        set: { value in
          router.appearanceOverride = nil
          model.appearance = AppearancePreference(rawValue: value) ?? .system
        }
      ))
      GroupedCard {
        WeaveToggleRow(
          "Coordinator beside threads",
          subtitle: "On an unfolded iPhone Duo or a wide window, keep the project's coordinator on the left while a thread is open.",
          symbol: "rectangle.split.2x1",
          isOn: Binding(get: { router.showsCoordinatorBeside }, set: { router.showsCoordinatorBeside = $0 })
        )
      }
    }
  }

  /// The language the composer's mic hears. Kept on this phone, like the
  /// same setting on each computer.
  private var dictationSection: some View {
    GroupedCard(label: "Dictation", footer: "Tap the mic in any chat. Words appear in the message unsent. Recognition stays on this iPhone when your language allows. Keyboard dictation, Wispr Flow included, works too.") {
      WeaveRow("Language", stacksTrailing: true) {
        WeaveRowSymbol("mic")
      } trailing: {
        Menu {
          Picker("Language", selection: $dictationLanguage) {
            ForEach(DictationText.languages, id: \.value) { Text($0.label).tag($0.value) }
          }
        } label: {
          HStack(spacing: WeaveSpacing.s1) {
            Text(DictationText.label(dictationLanguage)).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 12, weight: .medium))
              .accessibilityHidden(true)
          }
          .font(.weave(.body))
          .foregroundStyle(Color.weave.muted)
          .frame(minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
        }
        .accessibilityLabel("Dictation language, \(DictationText.label(dictationLanguage))")
      }
    }
  }

  /// How much of a thread's work the transcript shows. Kept on this phone,
  /// apart from the same setting on each computer.
  private var replies: some View {
    GroupedCard(label: "Replies", footer: model.timelineDetail.summary + ". Tap a turn's folded row to see its steps.") {
      WeaveRow("Show", stacksTrailing: true) {
        WeaveRowSymbol("list.bullet.indent")
      } trailing: {
        Menu {
          Picker("Show", selection: Binding(get: { model.timelineDetail }, set: { model.timelineDetail = $0 })) {
            ForEach(TimelineDetail.allCases) { Text($0.label).tag($0) }
          }
        } label: {
          HStack(spacing: WeaveSpacing.s1) {
            Text(model.timelineDetail.label).lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 12, weight: .medium))
              .accessibilityHidden(true)
          }
          .font(.weave(.body))
          .foregroundStyle(Color.weave.muted)
          .frame(minHeight: WeaveSize.minTap)
          .contentShape(Rectangle())
        }
        .accessibilityLabel("Show, \(model.timelineDetail.label)")
      }
    }
  }

  /// Without a name here computers see only "iPhone", since iOS gives apps
  /// the name the person gave the phone only with a special entitlement.
  private var deviceName: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      WeaveTextField("My iPhone", text: $deviceLabel, label: "Name of this iPhone")
        .nameInput()
      Text("Your computers list this phone by this name. It applies the next time this app opens.")
        .font(.weave(.caption))
        .foregroundStyle(Color.weave.muted)
        .padding(.horizontal, WeaveSpacing.s4)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private var about: some View {
    GroupedCard(label: "About", footer: aboutFooter) {
      WeaveRow("This iPhone", symbol: "iphone", trailingText: Self.thisPhone)
      WeaveRow("Version", symbol: "info.circle", trailingText: Self.version)
      WeaveRow("Privacy policy", subtitle: model.connect == nil ? "Nothing goes through a SpecWithCode server." : nil, symbol: "hand.raised", showsChevron: true) {
        openURL(AppLinks.privacyPolicy)
      }
      .accessibilityHint("Opens the privacy policy in Safari")
    }
  }

  private var aboutFooter: String {
    guard model.connect != nil else {
      return "Your phone talks straight to the machines you pair. They pass your messages to the AI tools you set up on them."
    }
    return "SpecWithCode Connect signs you in and finds your Macs. Your threads travel over an encrypted connection to your Mac, which passes your messages to the AI tools you set up on it."
  }

  private static var thisPhone: String {
    let device = ConnectDevice.current()
    return "\(device.model ?? "iPhone") · iOS \(device.iosMajorVersion)"
  }

  private static var version: String {
    let info = Bundle.main.infoDictionary
    let short = info?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    let build = info?["CFBundleVersion"] as? String
    return build.map { "\(short) (\($0))" } ?? short
  }
}

/// The default approval mode for new threads on one machine.
private struct MachineDefaultsCard: View {
  @Environment(AppModel.self) private var model
  @State private var selectedMachine: String?
  @State private var settings: MachineSettings?
  @State private var loading = false
  @State private var error: String?

  private var machineId: String? { selectedMachine ?? model.machines.first(where: { $0.status.isOnline })?.id ?? model.machines.first?.id }
  private var machine: MachineSummary? { machineId.flatMap { model.machine($0) } }
  private var rules: TeamRulesInfo? { machine?.teamRules }
  /// Who locks the picker, when the rules narrow it.
  private var modeLock: String? { rules.flatMap { $0.limitsModes ? $0.setByLabel : nil } }
  private var modes: [RuntimeModeChoice] { rules?.allowedModes ?? RuntimeModeChoice.allCases }

  /// What new threads really start with: a default above the limit is lowered to it.
  private func shownMode(_ settings: MachineSettings) -> RuntimeModeChoice {
    let mode = settings.defaultRuntimeMode ?? .approvalRequired
    return rules?.clamped(mode) ?? mode
  }

  var body: some View {
    GroupedCard(label: "Defaults", footer: footer, separatorInset: 56) {
      if model.machines.count > 1 {
        WeaveRow("Machine", stacksTrailing: true) {
          WeaveRowSymbol("laptopcomputer")
        } trailing: {
          Menu {
            Picker("Machine", selection: Binding(get: { machineId ?? "" }, set: { selectedMachine = $0 })) {
              ForEach(model.machines) { Text($0.displayName).tag($0.id) }
            }
          } label: {
            menuLabel(machine?.displayName ?? "Choose")
          }
          .accessibilityLabel("Machine, \(machine?.displayName ?? "none")")
        }
      }
      WeaveRow("New threads", subtitle: modeLock, stacksTrailing: true) {
        WeaveRowSymbol("hand.raised")
      } trailing: {
        if loading {
          ProgressView().controlSize(.small)
        } else if let settings {
          Menu {
            Picker("Approval mode", selection: Binding(
              get: { shownMode(settings) },
              set: { save(mode: $0) }
            )) {
              ForEach(modes, id: \.self) { Text($0.label).tag($0) }
            }
          } label: {
            menuLabel(shownMode(settings).label)
          }
          .accessibilityLabel("Approval mode for new threads, \(shownMode(settings).label)")
        } else {
          WeaveRowTrailingText("Unavailable")
        }
      }
    }
    .task(id: machineId) { await load() }
  }

  private var footer: String {
    if let error { return error }
    return "Used when a thread starts on \(machine?.displayName ?? "this machine"). Changes go to that machine."
  }

  private func menuLabel(_ text: String) -> some View {
    HStack(spacing: WeaveSpacing.s1) {
      Text(text).lineLimit(1)
      Image(systemName: "chevron.up.chevron.down")
        .font(.system(size: 12, weight: .medium))
        .accessibilityHidden(true)
    }
    .font(.weave(.body))
    .foregroundStyle(Color.weave.muted)
    .frame(minHeight: WeaveSize.minTap)
    .contentShape(Rectangle())
  }

  private func load() async {
    guard let machineId else { return }
    loading = true
    error = nil
    do {
      settings = try await model.engine.loadMachineSettings(machineId)
    } catch {
      settings = nil
      self.error = error.localizedDescription
    }
    loading = false
  }

  private func save(mode: RuntimeModeChoice) {
    guard let machineId, var updated = settings else { return }
    let previous = settings
    updated.defaultRuntimeMode = mode
    settings = updated
    Task {
      do {
        try await model.engine.saveMachineSettings(updated, for: machineId)
        error = nil
      } catch {
        settings = previous
        self.error = error.localizedDescription
      }
    }
  }
}
