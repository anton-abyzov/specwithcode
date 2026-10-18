import Foundation
import SWCTransport
import SWCWire

extension LiveEngine {
  // MARK: - Pairing

  public func pair(link: String) async throws -> MachineSummary {
    try await pair(link: link, expectedEnvironmentId: nil)
  }

  /// With `expectedEnvironmentId` ("Pair again" on a known machine), a link to
  /// any other machine fails before its one-time code is spent.
  public func pair(link: String, expectedEnvironmentId: String?) async throws -> MachineSummary {
    let pairing = MachinePairing(http: http, credentials: credentials, registry: registry)
    let result: PairingResult
    do {
      result = try await pairing.pair(link: link, clientLabel: options.clientLabel(), expectedEnvironmentId: expectedEnvironmentId)
    } catch {
      throw SyncError.wrap(error)
    }
    let env = result.record.environmentId
    let entry: MachineEntry
    if let existing = machines[env] {
      entry = existing
      entry.record = result.record
      entry.permissions = result.credential.permissions
      entry.tokenDaysLeft = result.credential.daysLeft()
      await entry.connection.update(result.record)
      await entry.connection.reconnect()
    } else {
      entry = addMachine(result.record, credential: result.credential)
    }
    publishNow()

    // Give the new connection a moment so the summary shows it online.
    let deadline = ContinuousClock.now + options.socketWait
    let settled: Set<MachineConnection.State> = [.connected, .needsRepair, .unsupported]
    while ContinuousClock.now < deadline, machines[env] === entry, !settled.contains(entry.status.state) {
      try? await Task.sleep(for: .milliseconds(100))
    }
    return summary(entry)
  }

  public func removeMachine(id: String) {
    guard let entry = machines.removeValue(forKey: id) else { return }
    machineOrder.removeAll { $0 == id }
    entry.cancel()
    entry.socket = nil
    let connection = entry.connection
    let registry = self.registry
    Task {
      await connection.setActive(false)
      _ = try? await registry.remove(id)
    }
    do {
      try credentials.remove(for: id)
    } catch {
      Self.log.error("Could not remove the token for \(id, privacy: .public): \(String(describing: error), privacy: .public)")
    }
    for controller in controllers.values where controller.environmentId == id {
      controller.task?.cancel()
      controller.task = nil
      refreshMeta(controller)
    }
    // Thread state of the removed machine is never resumed.
    retainedOrder.removeAll { target in
      guard target.environmentId == id else { return false }
      retainedThreads[target] = nil
      return true
    }
    publishNow()
  }

  // MARK: - Aide

  /// Creates Aide only once every paired machine is online with its projects
  /// listed: a machine that has not answered may already hold Aide, and a
  /// second one would split the conversation. Every client looks for Aide on
  /// the lowest environment id first, so that is where it goes.
  public func setupAide() async throws -> ProjectRef {
    if let aide = model?.aide { return aide.ref }
    let enabled = machines.values.filter(\.record.enabled).sorted { $0.environmentId < $1.environmentId }
    guard enabled.contains(where: \.isOnline) else { throw SyncError.noMachineConnected }
    guard enabled.allSatisfy({ $0.isOnline && $0.snapshot != nil }) else { throw SyncError.machinesNotLoaded }
    guard let entry = enabled.first(where: \.canOperate) else { throw SyncError.sendBlocked(Self.readOnlyReason) }
    let input = CreateNewProjectInput(name: "Aide", kind: .personal)
    let result = try await withRetry(entry.environmentId) { socket in
      try await Self.decode(CreateNewProjectResult.self, from: socket.call(tag: RpcMethod.createNewProject.rawValue, payload: JSONValue.from(input)))
    }
    return ProjectRef(environmentId: entry.environmentId, projectId: result.projectId)
  }

  // MARK: - Project settings

  public func loadProjectSettings(_ project: ProjectRef) async throws -> ProjectSettingsDraft {
    guard let entry = machines[project.environmentId] else { throw SyncError.unknownMachine }
    let input = WorkspaceReadInput(projectId: project.projectId)
    let result = try await withRetry(project.environmentId) { socket in
      try await Self.decode(WorkspaceReadResult.self, from: socket.call(tag: RpcMethod.workspaceRead.rawValue, payload: JSONValue.from(input)))
    }
    let settings = result.settings
    let shell = entry.project(project.projectId)
    return ProjectSettingsDraft(
      title: shell?.displayTitle ?? "",
      goal: settings.goal,
      instructions: settings.instructions,
      paused: settings.paused,
      archived: settings.archived,
      coordinatorModel: settings.coordinatorModelSelection.map { modelName($0, on: entry) },
      revision: settings.revision
    )
  }

  public func saveProjectSettings(_ draft: ProjectSettingsDraft, for project: ProjectRef) async throws {
    guard let entry = machines[project.environmentId] else { throw SyncError.unknownMachine }
    guard entry.canOperate else { throw SyncError.sendBlocked(Self.readOnlyReason) }
    let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { throw SyncError.emptyTitle }
    let current = entry.project(project.projectId)?.displayTitle
    let command = ProjectUpdateCommand(
      commandId: Self.newId(),
      projectId: project.projectId,
      title: title == current ? nil : title,
      workspaceSettings: WorkspacePatch(
        expectedRevision: draft.revision,
        goal: draft.goal,
        instructions: draft.instructions,
        paused: draft.paused,
        archived: draft.archived
      )
    )
    let payload = try JSONValue.from(command)
    do {
      _ = try await withRetry(project.environmentId) { socket in
        try await socket.call(tag: RpcMethod.projectsMutate.rawValue, payload: payload)
      }
    } catch let error as SyncError where Self.isRevisionConflict(error) {
      let latest = try? await loadProjectSettings(project)
      throw SyncError.projectConflict(latest: latest)
    }
  }

  /// The project changed since its settings were read.
  static func isRevisionConflict(_ error: SyncError) -> Bool {
    guard let server = error.serverError else { return false }
    switch server.kind {
    case let .projectWorkspace(code):
      return code == "conflict"
    case .projectMutation:
      if server.raw["cause"]?["reason"]?.stringValue == "settings_conflict" { return true }
      let message = server.message.lowercased()
      return message.contains("changed elsewhere") || message.contains("conflict")
    default:
      return false
    }
  }

  // MARK: - Machine settings

  public func loadMachineSettings(_ machineId: String) async throws -> MachineSettings {
    guard let entry = machines[machineId] else { throw SyncError.unknownMachine }
    let settings = try await withRetry(machineId) { socket in
      try await Self.decode(ServerSettings.self, from: socket.call(tag: RpcMethod.serverGetSettings.rawValue))
    }
    settingsChanged(entry, settings)
    return machineSettings(settings, on: entry)
  }

  public func saveMachineSettings(_ settings: MachineSettings, for machineId: String) async throws {
    guard let entry = machines[machineId] else { throw SyncError.unknownMachine }
    guard entry.canOperate else { throw SyncError.sendBlocked(Self.readOnlyReason) }
    // Only the runtime mode is editable on the phone.
    guard let mode = settings.defaultRuntimeMode else { return }
    let input = UpdateServerSettingsInput(patch: ServerSettingsPatch(defaultRuntimeMode: RuntimeMode(rawValue: mode.rawValue)))
    let updated = try await withRetry(machineId) { socket in
      try await Self.decode(ServerSettings.self, from: socket.call(tag: RpcMethod.serverUpdateSettings.rawValue, payload: JSONValue.from(input)))
    }
    settingsChanged(entry, updated)
  }

  func settingsChanged(_ entry: MachineEntry, _ settings: ServerSettings) {
    guard machines[entry.environmentId] === entry else { return }
    entry.settings = settings
    schedulePublish()
  }

  func machineSettings(_ settings: ServerSettings, on entry: MachineEntry) -> MachineSettings {
    MachineSettings(
      defaultRuntimeMode: settings.defaultRuntimeMode.flatMap { RuntimeModeChoice(rawValue: $0.rawValue) },
      defaultModel: settings.defaultModelSelection.map { modelName($0, on: entry) }
    )
  }

  func modelName(_ selection: ModelSelection, on entry: MachineEntry) -> String {
    entry.config?.provider(selection.instanceId)?.modelName(selection.model) ?? selection.model
  }
}
