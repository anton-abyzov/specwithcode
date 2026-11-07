import Foundation
import Network
import Observation
import os
import SWCTransport
import SWCWire

/// The engine for real machines: one supervised socket per paired machine,
/// a shell subscription on each, and a thread subscription per open chat.
@MainActor
public final class LiveEngine: AppEngine {
  public struct Options: Sendable {
    /// Shown on the computer as the paired device's name. Read at each
    /// pairing, so a new name applies without a relaunch.
    public var clientLabel: @Sendable @MainActor () -> String
    /// Model updates are coalesced to at most one per interval.
    public var publishInterval: Duration
    /// `isLoading` turns off after this even if a machine never answers.
    public var loadingTimeout: Duration
    /// How long a command waits for a machine to come online.
    public var socketWait: Duration
    /// Retries of a command after a transient failure, with the same ids.
    public var retryLimit: Int
    public var retryDelay: Duration
    public var connection: MachineConnection.Configuration
    /// Watches the network path and skips reconnect backoff when it changes.
    public var monitorsNetwork: Bool
    /// First wait before a failed shell or thread stream subscribes again on
    /// the same socket; it doubles per failure up to `resubscribeMaximum`.
    public var resubscribeDelay: Duration
    public var resubscribeMaximum: Duration
    /// How often one connected machine is asked for the rest of its fleet.
    public var fleetLinkInterval: Duration
    /// How often a live thread list is saved for when its machine is unreachable.
    public var shellSaveInterval: Duration
    /// How long an open chat may trail the thread list before it subscribes again.
    public var staleThreadGrace: Duration
    /// Minimum time between two catch-ups of every live stream on foreground.
    public var resyncInterval: Duration
    /// How long a machine that has not connected yet reads "Connecting" after
    /// the app opens or comes back to the front, before it says offline. It
    /// covers the first attempt; a failed attempt shows at once.
    public var connectingGrace: Duration
    /// The engine's clock, for the connecting grace.
    public var now: @Sendable () -> ContinuousClock.Instant

    public init(
      clientLabel: @escaping @Sendable @MainActor () -> String = { "iPhone" },
      publishInterval: Duration = .milliseconds(50),
      loadingTimeout: Duration = .seconds(15),
      socketWait: Duration = .seconds(10),
      retryLimit: Int = 3,
      retryDelay: Duration = .milliseconds(500),
      connection: MachineConnection.Configuration = MachineConnection.Configuration(),
      monitorsNetwork: Bool = true,
      resubscribeDelay: Duration = .milliseconds(250),
      resubscribeMaximum: Duration = .seconds(30),
      fleetLinkInterval: Duration = .seconds(600),
      shellSaveInterval: Duration = .seconds(30),
      staleThreadGrace: Duration = .seconds(3),
      resyncInterval: Duration = .seconds(10),
      connectingGrace: Duration = .seconds(3),
      now: @escaping @Sendable () -> ContinuousClock.Instant = { ContinuousClock.now }
    ) {
      self.clientLabel = clientLabel
      self.publishInterval = publishInterval
      self.loadingTimeout = loadingTimeout
      self.socketWait = socketWait
      self.retryLimit = retryLimit
      self.retryDelay = retryDelay
      self.connection = connection
      self.monitorsNetwork = monitorsNetwork
      self.resubscribeDelay = resubscribeDelay
      self.resubscribeMaximum = resubscribeMaximum
      self.fleetLinkInterval = fleetLinkInterval
      self.shellSaveInterval = shellSaveInterval
      self.staleThreadGrace = staleThreadGrace
      self.resyncInterval = resyncInterval
      self.connectingGrace = connectingGrace
      self.now = now
    }
  }

  static let log = Logger(subsystem: "com.specwithcode.ios", category: "engine")

  let registry: MachineRegistry
  let credentials: any CredentialStore
  let http: MachineHTTP
  let connector: any WebSocketConnector
  let options: Options

  weak var model: AppModel?
  var machines: [String: MachineEntry] = [:]
  /// Pairing order, for the machines list.
  var machineOrder: [String] = []
  var controllers: [ChatTarget: SessionController] = [:]
  /// Thread state of recently closed conversations, so reopening one resumes
  /// with `afterSequence` instead of downloading the snapshot again.
  var retainedThreads: [ChatTarget: RetainedThread] = [:]
  /// Least recently closed first.
  var retainedOrder: [ChatTarget] = []
  static let retainedThreadLimit = 8
  var active = true
  var lastResync: ContinuousClock.Instant?
  var started = false
  var loadingDeadlinePassed = false
  /// SpecWithCode Connect, when the build is configured for it.
  let connect: ConnectRuntime?
  /// Thread lists and last-seen times kept for unreachable machines.
  let fleetCache: FleetCache?
  let handoffJournal: HandoffJournal
  /// Names of machines known from a fleet roster, by environment id.
  var fleetNames: [String: String] = [:]
  /// Machines whose projects are listed; see `FleetCache.home()`.
  var fleetHome: Set<String> = []
  var fleetLinkedAt: [String: ContinuousClock.Instant] = [:]
  /// Each machine's rows from the last publish, so a change on one machine
  /// does not summarize every other machine's threads again.
  let summaryCache = ShellSummaries.Cache()
  /// The user's machine nicknames, merged from every machine's settings.
  var fleetNicknames: [String: String] {
    MachineNickname.merge(machineOrder.compactMap { machines[$0]?.settings?.machineNicknames })
  }
  var fleetLinking = false
  var connectionChanges: Set<String> = []
  private var publishTask: Task<Void, Never>?
  /// Publishes again when the earliest connecting grace runs out.
  private var graceTask: Task<Void, Never>?
  private var pathMonitor: NWPathMonitor?
  private var lastPathSatisfied: Bool?

  public init(
    registry: MachineRegistry,
    credentials: any CredentialStore = KeychainCredentialStore(),
    http: MachineHTTP = MachineHTTP(),
    connector: any WebSocketConnector = URLSessionWebSocketConnector(),
    options: Options = Options(),
    connect: ConnectRuntime? = nil,
    fleetCache: FleetCache? = nil,
    handoffDefaults: UserDefaults? = nil
  ) {
    self.registry = registry
    self.credentials = credentials
    self.http = http
    self.connector = connector
    self.options = options
    self.connect = connect
    self.fleetCache = fleetCache
    self.handoffJournal = HandoffJournal(defaults: handoffDefaults)
  }

  /// The engine the app uses: the registry in Application Support and tokens in the Keychain.
  public convenience init(clientLabel: String) {
    self.init(clientLabel: { clientLabel })
  }

  /// Like `init(clientLabel:)`, asking for the device name at each pairing.
  /// With `account`, the person can sign in to SpecWithCode Connect.
  public convenience init(clientLabel: @escaping @Sendable @MainActor () -> String, account: (any ConnectAccount)? = nil) {
    let url = (try? MachineRegistry.defaultFileURL()) ?? FileManager.default.temporaryDirectory.appendingPathComponent("machines.json")
    let credentials = KeychainCredentialStore()
    let connect = account.map { ConnectRuntime(account: $0, credentials: credentials, clientLabel: clientLabel(), device: .current(label: clientLabel())) }
    let cache = FleetCache(directory: url.deletingLastPathComponent().appendingPathComponent("Fleet", isDirectory: true))
    self.init(registry: MachineRegistry(fileURL: url), credentials: credentials, options: Options(clientLabel: clientLabel), connect: connect, fleetCache: cache, handoffDefaults: .standard)
  }

  // MARK: - Lifecycle

  public func start(model: AppModel) {
    guard !started else { return }
    started = true
    self.model = model
    if options.monitorsNetwork { startPathMonitor() }
    if let connect { model.connect = ConnectState(methods: ConnectSignInMethod.offered(by: connect.account.config), wasRemoved: connect.wasRemoved) }
    Task {
      await bootstrap()
      await startConnect()
    }
    let timeout = options.loadingTimeout
    Task { [weak self] in
      try? await Task.sleep(for: timeout)
      guard let self else { return }
      self.loadingDeadlinePassed = true
      self.publishNow()
    }
  }

  func bootstrap() async {
    for record in await registry.all() where machines[record.environmentId] == nil {
      adoptLegacyCredential(record)
      addMachine(record, credential: credentials.bestCredential(for: record))
    }
    await loadFleetCache()
    publishNow()
  }

  /// A token saved before tokens were bound to their route belongs to the
  /// machine's only saved route; with several, its issuer is unknown.
  func adoptLegacyCredential(_ record: MachineRecord) {
    let saved = record.routes.filter { !$0.learned }
    guard saved.count == 1, let route = saved.first,
          (try? credentials.credential(for: route, of: record.environmentId)) == nil else { return }
    _ = try? credentials.adoptLegacyCredential(for: record.environmentId, issuer: route.issuer)
  }

  public func setActive(_ value: Bool) {
    let wasActive = active
    active = value
    if !value { saveFleetCache() }
    if value { refreshConnectIfStale() }
    // Back in front, every connection starts again: each machine not yet
    // connected reads "Connecting" through its first attempt.
    if value, !wasActive {
      for entry in machines.values { startConnectingGrace(entry) }
      scheduleGraceExpiry()
    } else if !value {
      for entry in machines.values { entry.settlingUntil = nil }
      scheduleGraceExpiry()
    }
    for entry in machines.values {
      let connection = entry.connection
      // Tasks may run out of order; each applies the latest flag.
      Task { [weak self] in await connection.setActive(self?.active ?? value) }
    }
    // Back in front with sockets that stayed open: they may have stalled
    // unnoticed, so the lists and open chats catch up from where they were.
    if value, wasActive { resyncLive() }
  }

  /// Subscribes the shells and open chats again on their live sockets,
  /// resuming from the last sequence, at most once per `resyncInterval`.
  func resyncLive() {
    let now = ContinuousClock.now
    if let last = lastResync, now - last < options.resyncInterval { return }
    lastResync = now
    for entry in machines.values {
      guard let socket = entry.socket else { continue }
      entry.shellTask?.cancel()
      entry.shellTask = Task { [weak self] in
        guard let self, !(await socket.isClosed) else { return }
        await self.subscribeShell(entry, socket)
      }
    }
    for controller in controllers.values { resync(controller) }
  }

  public func reconnect(machineId: String) {
    guard let connection = machines[machineId]?.connection else { return }
    Task { await connection.reconnect() }
  }

  public func wake(machineId: String) {
    guard let connection = machines[machineId]?.connection else { return }
    Task { await connection.networkChanged() }
  }

  // MARK: - Machines

  @discardableResult
  func addMachine(_ record: MachineRecord, credential: MachineCredential?) -> MachineEntry {
    let connection = MachineConnection(record: record, credentials: credentials, http: http, connector: connector, configuration: options.connection, authorizer: connect?.authorizer)
    let entry = MachineEntry(record: record, connection: connection)
    entry.permissions = credential?.permissions
    entry.tokenDaysLeft = credential?.daysLeft()
    entry.answered = !record.enabled
    let env = record.environmentId
    machines[env] = entry
    if !machineOrder.contains(env) { machineOrder.append(env) }

    entry.tasks.append(Task { [weak self] in
      for await status in await connection.statusUpdates() {
        self?.statusChanged(env, status)
      }
    })
    entry.tasks.append(Task { [weak self] in
      for await socket in await connection.connectedSockets() {
        self?.socketConnected(env, socket)
      }
    })
    if active {
      startConnectingGrace(entry)
      scheduleGraceExpiry()
      Task { await connection.setActive(true) }
    }
    return entry
  }

  // MARK: - Connecting grace

  /// Starts the window in which `entry`, until it connects, reads "Connecting".
  /// A status that still says connected may be from before the app went to
  /// the background, so the window starts anyway; connecting ends it.
  func startConnectingGrace(_ entry: MachineEntry) {
    entry.settlingUntil = entry.record.enabled ? options.now() + options.connectingGrace : nil
  }

  /// Publishes when the earliest running grace ends, so a machine that never
  /// answered turns offline on screen without waiting for another event.
  func scheduleGraceExpiry() {
    graceTask?.cancel()
    graceTask = nil
    let now = options.now()
    guard let deadline = machines.values.filter({ $0.isSettling(at: now) }).compactMap(\.settlingUntil).min() else { return }
    let delay = deadline - now
    graceTask = Task { [weak self] in
      try? await Task.sleep(for: delay)
      guard !Task.isCancelled, let self else { return }
      self.graceTask = nil
      self.publishNow()
      self.scheduleGraceExpiry()
    }
  }

  func statusChanged(_ env: String, _ status: MachineConnection.Status) {
    guard let entry = machines[env] else { return }
    let dropped = entry.status.state == .connected && status.state != .connected
    if dropped { markSeen(entry) }
    entry.status = status
    if case let .connect(error)? = status.lastError, error.isDeviceRemoved {
      Task { await connectHandleRemoval(error) }
    }
    if let days = status.tokenDaysLeft { entry.tokenDaysLeft = days }
    // Connected, or the attempt really failed: the grace is over for good.
    if status.state == .connected || MachineEntry.isFailure(status) {
      entry.settlingUntil = nil
    } else if dropped, active {
      // A dropped connection that is reconnecting reads "Connecting" through
      // the grace, as at launch, so a short Wi-Fi blip never says offline.
      startConnectingGrace(entry)
      scheduleGraceExpiry()
    }
    switch status.state {
    case .connected:
      break
    case .needsRepair, .unsupported:
      entry.answered = true
      entry.isSynchronized = false
    case .offline, .connecting, .reconnecting:
      entry.isSynchronized = false
      if status.lastError != nil { entry.answered = true }
    }
    // Status and socket events have separate consumers. A buffered probe
    // must not overwrite the newer name received through server.getConfig.
    if entry.config == nil, let label = status.descriptor?.label { rename(entry, label) }
    for controller in controllers.values where controller.environmentId == env {
      refreshMeta(controller)
    }
    schedulePublish()
  }

  func socketConnected(_ env: String, _ socket: RpcSocket) {
    guard let entry = machines[env], entry.record.enabled else {
      Task { await socket.close() }
      return
    }
    entry.socket = socket
    entry.configTask?.cancel()
    entry.shellTask?.cancel()
    entry.settingsTask?.cancel()
    entry.deviceTask?.cancel()
    entry.configTask = Task { [weak self] in await self?.loadConfig(entry, socket) }
    entry.shellTask = Task { [weak self] in await self?.subscribeShell(entry, socket) }
    entry.settingsTask = Task { [weak self] in await self?.watchSettings(entry, socket) }
    entry.deviceTask = Task { [weak self] in await self?.watchDevices(entry, socket) }
    pumpSessions(on: env)
  }

  func loadConfig(_ entry: MachineEntry, _ socket: RpcSocket) async {
    do {
      let value = try await socket.call(tag: RpcMethod.serverGetConfig.rawValue)
      let config = try await Self.decode(ServerConfig.self, from: value)
      guard machines[entry.environmentId] === entry else { return }
      entry.config = config
      teamRulesChanged(entry, config.teamRules)
      if let settings = config.settings {
        entry.settings = settings
        rememberAide(entry)
      }
      rename(entry, config.environment.label)
      learnRoutes(entry, socket, config.directEndpoints.map(\.httpBaseUrl))
      schedulePublish()
      Task { [weak self] in await self?.linkFleet(via: entry) }
    } catch is CancellationError {
    } catch {
      Self.log.error("server.getConfig failed on \(entry.environmentId, privacy: .public): \(String(describing: error), privacy: .public)")
      verifySessionIfUnauthorized(entry, error)
    }
  }

  /// Keeps the shell subscribed on this socket. A failed or ended stream on a
  /// socket that is still open subscribes again with backoff, resuming from the
  /// last snapshot, as client-runtime does; authorization failures are final.
  func subscribeShell(_ entry: MachineEntry, _ socket: RpcSocket) async {
    let sync = entry.shell
    var failures = 0
    while !Task.isCancelled {
      await sync.beginSubscription()
      let input = SubscribeShellInput(afterSequence: await sync.resumeSequence, requestCompletionMarker: true)
      let payload = (try? JSONValue.from(input)) ?? .object([:])
      let stream = await socket.stream(tag: RpcMethod.subscribeShell.rawValue, payload: payload)
      do {
        for try await chunk in stream {
          failures = 0
          let update = await sync.apply(chunk.values)
          chunk.ack()
          // A cancelled task (a foreground catch-up) must not write over the new subscription.
          if Task.isCancelled { return }
          if let update { shellUpdated(entry, update) }
        }
      } catch is CancellationError {
        return
      } catch let error as ServerError {
        Self.log.error("Shell subscription failed on \(entry.environmentId, privacy: .public): \(error.message, privacy: .public)")
        entry.answered = true
        verifySessionIfUnauthorized(entry, error)
        if case .authorization = error.kind {
          markShellStale(entry, socket)
          return
        }
      } catch {
        // The socket closed; the next socket subscribes again.
        markShellStale(entry, socket)
        return
      }
      // The stream failed or ended while the socket may still be open.
      guard !Task.isCancelled, machines[entry.environmentId] === entry, entry.socket === socket, !(await socket.isClosed) else {
        markShellStale(entry, socket)
        return
      }
      markShellStale(entry, socket)
      let delay = resubscribeDelay(afterFailures: failures)
      failures += 1
      try? await Task.sleep(for: delay)
    }
  }

  /// The shell list stopped being live on this socket.
  func markShellStale(_ entry: MachineEntry, _ socket: RpcSocket) {
    // A cancelled task or a replaced socket must not mark the new subscription stale.
    guard !Task.isCancelled, machines[entry.environmentId] === entry, entry.socket === socket else { return }
    entry.isSynchronized = false
    schedulePublish()
  }

  /// Backoff before subscribing again on the same socket: doubles from
  /// `resubscribeDelay` up to `resubscribeMaximum`.
  func resubscribeDelay(afterFailures failures: Int) -> Duration {
    min(options.resubscribeDelay * (1 << min(max(failures, 0), 16)), options.resubscribeMaximum)
  }

  func shellUpdated(_ entry: MachineEntry, _ update: ShellSync.Update) {
    guard machines[entry.environmentId] === entry else { return }
    let first = entry.snapshot == nil && update.snapshot != nil
    entry.snapshot = update.snapshot
    if update.snapshot != nil { entry.cachedSnapshot = nil }
    entry.isSynchronized = update.isSynchronized
    if update.isSynchronized { saveShellIfDue(entry) }
    if update.snapshot != nil || update.isSynchronized { entry.answered = true }
    if first { pumpSessions(on: entry.environmentId) }
    schedulePublish()
  }

  func rename(_ entry: MachineEntry, _ label: String) {
    let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !label.isEmpty, label != entry.record.label else { return }
    entry.record.label = label
    let registry = self.registry
    let env = entry.environmentId
    Task { _ = try? await registry.update(env) { $0.label = label } }
  }

  /// Saves the addresses the server reports, so another route can take over
  /// later. They use the token of the route this socket was opened on.
  func learnRoutes(_ entry: MachineEntry, _ socket: RpcSocket, _ reported: [String]) {
    let registry = self.registry
    let env = entry.environmentId
    Task { [weak self] in
      // A Connect token is bound to the device key and only goes to the tunnel.
      guard let route = await entry.connection.route(of: socket), route.issuer != ConnectAuthorizer.issuer,
            let updated = try? await registry.mergeLearnedRoutes(reported, issuer: route.issuer, for: env) else { return }
      guard let self, self.machines[env] === entry, updated.routes != entry.record.routes else { return }
      entry.record.routes = updated.routes
      await entry.connection.update(entry.record)
    }
  }

  func verifySessionIfUnauthorized(_ entry: MachineEntry, _ error: Error) {
    guard let server = (error as? ServerError) ?? (error as? SyncError)?.serverError,
          case .authorization = server.kind else { return }
    let connection = entry.connection
    Task { await connection.verifySession() }
  }

  // MARK: - Publishing

  func schedulePublish() {
    guard publishTask == nil else { return }
    let interval = options.publishInterval
    publishTask = Task { [weak self] in
      try? await Task.sleep(for: interval)
      // publishNow() cancels this task and publishes itself; a cancelled task
      // must neither publish again nor clear a newer task's handle.
      guard !Task.isCancelled, let self else { return }
      self.publishTask = nil
      self.publish()
    }
  }

  func publishNow() {
    publishTask?.cancel()
    publishTask = nil
    publish()
  }

  func publish() {
    guard let model else { return }
    let entries = machineOrder.compactMap { machines[$0] }
    let nicknames = fleetNicknames
    let now = options.now()
    assign(model, \.machines, entries.map { summary($0, nicknames: nicknames, now: now) })
    // Aide is a switch in the desktop's settings; any machine saying so shows it.
    let aideEnabled = AideSetting.visible(entries.map { aideMachine($0, nicknames: nicknames) }, previous: model.aideEnabled)
    assign(model, \.aideEnabled, aideEnabled)

    let output = ShellSummaries.build(entries.map { entry in
      // A live list replaces the saved one wholesale, so a reconnect never doubles rows.
      ShellSummaries.Machine(environmentId: entry.environmentId, label: entry.label, online: entry.isOnline, settling: entry.isSettling(at: now), snapshot: entry.snapshot ?? entry.cachedSnapshot, projectOrder: entry.settings?.sidebarProjectOrder, scratchWorkspaceRoot: entry.config?.scratchWorkspaceRoot, lastSeenAt: entry.lastSeenAt, providers: entry.config?.providers ?? [])
    }, names: fleetNames, nicknames: nicknames, home: fleetHome, includeAide: aideEnabled, cache: summaryCache)
    assign(model, \.aide, output.aide)
    assign(model, \.projects, output.projects)
    assign(model, \.threadsByProject, output.threadsByProject)
    assign(model, \.recentThreads, output.recentThreads)
    assign(model, \.devices, entries.reduce(into: [:]) { devices, entry in
      // An offline machine's last state is stale, so it offers no devices.
      if entry.record.enabled, entry.isOnline, let value = entry.devices { devices[entry.environmentId] = value }
    })

    let loading = !loadingDeadlinePassed && entries.contains { $0.record.enabled && !$0.answered }
    assign(model, \.isLoading, loading)
    assign(model, \.allShellsLoaded, entries.allSatisfy { !$0.record.enabled || $0.snapshot != nil })
    assign(model, \.unloadedShells, Set(entries.filter { $0.snapshot == nil }.map(\.environmentId)))

    for controller in controllers.values {
      if controller.threadId == nil {
        pump(controller)
        // Without a socket `pump` does nothing, so the machine state is set here.
        refreshMeta(controller)
      } else {
        retryMissingCoordinator(controller)
        followCoordinator(controller)
        refreshMeta(controller)
        checkBehind(controller)
      }
      visitIfUnread(controller)
    }
  }

  /// The name the machine goes by in rows, titles and notices.
  func displayName(_ entry: MachineEntry, nicknames: [String: String]? = nil) -> String {
    MachineNickname.resolve(environmentId: entry.environmentId, label: entry.label, nicknames: nicknames ?? fleetNicknames)
  }

  /// Names machines by environment id for routed messages: a paired machine's
  /// display name, else a fleet name, else the id itself.
  func machineLabelResolver() -> (String) -> String {
    let nicknames = fleetNicknames
    let names = machines.mapValues { displayName($0, nicknames: nicknames) }
    let fleet = fleetNames
    return { id in
      names[id] ?? MachineNickname.resolve(environmentId: id, label: fleet[id] ?? "", nicknames: nicknames)
    }
  }

  func aideMachine(_ entry: MachineEntry, nicknames: [String: String]? = nil) -> AideSetting.Machine {
    AideSetting.Machine(environmentId: entry.environmentId, displayName: displayName(entry, nicknames: nicknames), enabled: entry.record.enabled, aideEnabled: entry.settings?.aideEnabled, cachedAideEnabled: entry.cachedAideEnabled, canOperate: entry.canOperate, listed: entry.isOnline || entry.cachedSnapshot != nil)
  }

  func summary(_ entry: MachineEntry, nicknames: [String: String]? = nil, now: ContinuousClock.Instant? = nil) -> MachineSummary {
    let settling = entry.isSettling(at: now ?? options.now())
    var status: MachineStatus = entry.record.enabled ? (MachineStatus(rawValue: entry.status.state.rawValue) ?? .offline) : .offline
    // No attempt has answered yet: offline here only means "no socket yet",
    // and a dropped connection reads "Connecting" as at launch.
    if settling, status == .offline || status == .reconnecting { status = .connecting }
    var result = MachineSummary(
      id: entry.environmentId,
      label: entry.label,
      displayName: displayName(entry, nicknames: nicknames),
      status: status,
      platform: entry.config?.environment.platform.displayName ?? entry.status.descriptor?.platformLabel,
      serverVersion: entry.config?.environment.serverVersion ?? entry.status.descriptor?.serverVersion,
      address: (entry.status.route ?? entry.record.rankedRoutes.first)?.address,
      tokenDaysLeft: entry.record.routes.isEmpty || entry.status.route?.issuer == ConnectAuthorizer.issuer ? nil : entry.tokenDaysLeft,
      isStale: entry.isOnline && entry.snapshot != nil && !entry.isSynchronized,
      viaConnect: entry.record.connectRoute != nil,
      needsSignIn: entry.status.lastError == .connect(.signedOut),
      checkedAt: entry.isOnline ? nil : connect?.checkedAt[entry.environmentId],
      hasDirectPairing: !entry.record.routes.isEmpty
    )
    result.isDisconnected = !entry.record.enabled
    result.isSettling = settling
    if case .http(status: 429, code: _)? = entry.status.lastError { result.isRefusingSignIns = true }
    if case let .teamRules(message)? = entry.status.lastError { result.teamRulesRefusal = message }
    result.teamRules = entry.teamRules.map(TeamRulesInfo.init)
    return result
  }

  // MARK: - Network

  private func startPathMonitor() {
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] path in
      let satisfied = path.status == .satisfied
      Task { @MainActor in self?.pathChanged(satisfied: satisfied) }
    }
    monitor.start(queue: DispatchQueue(label: "com.specwithcode.ios.path"))
    pathMonitor = monitor
  }

  private func pathChanged(satisfied: Bool) {
    defer { lastPathSatisfied = satisfied }
    guard let last = lastPathSatisfied, last != satisfied || satisfied else { return }
    for entry in machines.values {
      let connection = entry.connection
      Task { await connection.networkChanged() }
    }
  }

  // MARK: - Helpers

  /// Decodes a result away from the main actor.
  @concurrent
  nonisolated static func decode<T: Decodable & Sendable>(_ type: T.Type, from value: JSONValue) async throws -> T {
    try value.decode(T.self)
  }

  static func newId() -> String { UUID().uuidString.lowercased() }
}

/// Sets an observable property only when the value differs, so views that
/// read it are not invalidated for nothing.
@MainActor
func assign<Root: AnyObject, Value: Equatable>(_ root: Root, _ keyPath: ReferenceWritableKeyPath<Root, Value>, _ value: Value) {
  if root[keyPath: keyPath] != value { root[keyPath: keyPath] = value }
}

/// One paired machine as the engine tracks it.
@MainActor
final class MachineEntry {
  let environmentId: String
  var record: MachineRecord
  let connection: MachineConnection
  let shell = ShellSync()
  var status = MachineConnection.Status(state: .offline)
  var config: ServerConfig?
  var settings: ServerSettings?
  /// Last known Team rules: `config`'s, then whatever the settings stream says.
  var teamRules: TeamRulesSummary?
  var snapshot: ShellSnapshot?
  /// The thread list saved on the phone, shown until the live one arrives.
  var cachedSnapshot: ShellSnapshot?
  /// The machine's `aideEnabled` saved on the phone, used until `settings` arrive.
  var cachedAideEnabled: Bool?
  /// When the phone last had this machine connected.
  var lastSeenAt: Date?
  var shellSavedAt: ContinuousClock.Instant?
  var isSynchronized = false
  /// The machine answered once, or failed; `isLoading` waits for this.
  var answered = false
  /// Until then the machine, not connected yet, reads "Connecting" while its
  /// first attempt runs. Cleared once it connects or an attempt fails.
  var settlingUntil: ContinuousClock.Instant?
  var socket: RpcSocket?
  var permissions: [String]?
  var tokenDaysLeft: Int?
  var tasks: [Task<Void, Never>] = []
  var configTask: Task<Void, Never>?
  var shellTask: Task<Void, Never>?
  var settingsTask: Task<Void, Never>?
  var deviceTask: Task<Void, Never>?
  /// The machine's open devices, from `subscribeDeviceState`.
  var devices: MachineDevices?

  init(record: MachineRecord, connection: MachineConnection) {
    self.environmentId = record.environmentId
    self.record = record
    self.connection = connection
  }

  var label: String { record.label }
  var isOnline: Bool { record.enabled && status.state == .connected }

  /// Not connected yet and its first attempt has neither failed nor run past
  /// the connecting grace.
  func isSettling(at now: ContinuousClock.Instant) -> Bool {
    guard let settlingUntil, record.enabled, status.state != .connected, !Self.isFailure(status) else { return false }
    return now < settlingUntil
  }

  /// An attempt finished with an error, or the pairing needs the person.
  nonisolated static func isFailure(_ status: MachineConnection.Status) -> Bool {
    status.lastError != nil || status.state == .needsRepair || status.state == .unsupported
  }

  /// False when the pairing is known to lack `orchestration:operate`.
  var canOperate: Bool {
    guard let permissions, !permissions.isEmpty else { return true }
    return permissions.contains("orchestration:operate")
  }

  func project(_ id: String) -> ProjectShell? {
    snapshot?.projects.first { $0.id == id }
  }

  func thread(_ id: String) -> ThreadShell? {
    snapshot?.threads.first { $0.id == id }
  }

  func cancel() {
    for task in tasks { task.cancel() }
    tasks = []
    configTask?.cancel()
    shellTask?.cancel()
    settingsTask?.cancel()
    deviceTask?.cancel()
  }
}
