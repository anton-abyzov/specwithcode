import Foundation
import os
import SWCTransport

/// The relay client and credentials behind SpecWithCode Connect.
@MainActor
public final class ConnectRuntime {
  public let account: any ConnectAccount
  let relay: RelayClient
  let authorizer: ConnectAuthorizer
  /// Identifies this phone to the relay; kept across launches.
  let deviceId: String
  var checkedAt: [String: Date] = [:]
  var lastRefresh: Date?
  var refreshTask: Task<Void, Never>?
  /// What the relay is told about this phone for notifications.
  let device: ConnectDevice
  /// The APNs token in hex, once the system handed one over.
  var pushToken: String?
  /// The account and push token state of the registration the relay accepted.
  var registeredPush: String?
  /// A registration is being sent; `registrationPending` asks for one more
  /// after it, with whatever changed meanwhile.
  var registering = false
  var registrationPending = false
  private let defaults: UserDefaults
  /// Set while this phone signs out after the relay said it was removed.
  var handlingRemoval = false
  /// Set while the person signs out or deletes the account on this phone, so
  /// the Clerk session ending meanwhile is not taken for a removal.
  var signingOut = false
  /// The Clerk session ended without the person signing out here; a
  /// device_removed refusal arriving later still counts.
  var sessionEndedElsewhere = false
  /// A rejected session is being turned into signed out.
  var rejectingSession = false

  /// The relay said this phone was removed from the account; cleared by the
  /// next successful sign-in.
  var wasRemoved: Bool {
    get { defaults.bool(forKey: Self.removedKey) }
    set { defaults.set(newValue, forKey: Self.removedKey) }
  }

  /// This phone was signed in last time and the person has not signed out
  /// since. Finding it signed out anyway means the session ended elsewhere,
  /// perhaps because the phone was removed from the account.
  var wasSignedIn: Bool {
    get { defaults.bool(forKey: Self.signedInKey) }
    set { defaults.set(newValue, forKey: Self.signedInKey) }
  }

  public init(
    account: any ConnectAccount,
    credentials: any CredentialStore,
    clientLabel: String,
    device: ConnectDevice = .current(),
    keys: any DpopKeyStore = KeychainDpopKeyStore(),
    transport: any HTTPTransport = URLSessionHTTPTransport(),
    http: MachineHTTP = MachineHTTP(),
    defaults: UserDefaults = .standard
  ) {
    self.account = account
    self.device = device
    self.defaults = defaults
    let bridge = ConnectSessionBridge { [account] refresh in try await account.sessionToken(refresh: refresh) }
    let deviceId = Self.deviceId(defaults)
    self.deviceId = deviceId
    relay = RelayClient(config: account.config, session: bridge, keys: keys, transport: transport, deviceId: deviceId)
    authorizer = ConnectAuthorizer(relay: relay, credentials: credentials, http: http, deviceId: deviceId, clientLabel: clientLabel)
  }

  static let deviceIdKey = "SWCConnectDeviceId"
  static let removedKey = "SWCConnectPhoneRemoved"
  static let signedInKey = "SWCConnectWasSignedIn"

  static func deviceId(_ defaults: UserDefaults) -> String {
    if let saved = defaults.string(forKey: deviceIdKey), !saved.isEmpty { return saved }
    let id = UUID().uuidString.lowercased()
    defaults.set(id, forKey: deviceIdKey)
    return id
  }
}

extension LiveEngine {
  static let refreshInterval: TimeInterval = 60

  /// Restores a saved sign-in and lists the account's computers.
  func startConnect() async {
    guard let connect else { return }
    await connect.account.load()
    updateConnect { $0.user = connect.account.currentUser }
    if connect.account.currentUser != nil {
      connect.wasSignedIn = true
      await connectRefresh()
      await connectAfterSignIn()
    } else {
      await connectSessionEnded()
    }
  }

  public func connectSignIn(with method: ConnectSignInMethod) async throws {
    guard let connect else { return }
    updateConnect { $0.isBusy = true; $0.lastError = nil }
    defer { updateConnect { $0.isBusy = false } }
    do {
      try await connect.account.signIn(with: method)
    } catch {
      updateConnect { $0.lastError = error.localizedDescription }
      throw error
    }
    connect.wasRemoved = false
    connect.wasSignedIn = true
    connect.sessionEndedElsewhere = false
    updateConnect { $0.user = connect.account.currentUser; $0.wasRemoved = false }
    await connectRefresh()
    await connectAfterSignIn()
  }

  public func connectSignOut() async {
    await signOutOfConnect(unregister: true)
  }

  /// `unregister` first stops notifications to this phone; a phone the relay
  /// already removed skips it, since the relay would refuse it.
  private func signOutOfConnect(unregister: Bool) async {
    guard let connect else { return }
    updateConnect { $0.isBusy = true }
    connect.signingOut = true
    defer { connect.signingOut = false }
    connect.wasSignedIn = false
    connect.sessionEndedElsewhere = false
    if unregister {
      await connectBeforeSignOut()
    } else {
      connect.registeredPush = nil
    }
    do {
      try await connect.account.signOut()
    } catch {
      Self.log.error("Sign out failed: \(String(describing: error), privacy: .public)")
    }
    await forgetConnect()
    updateConnect { $0.isBusy = false }
  }

  // MARK: - Phones

  public func connectPhones() async throws -> [ConnectPhone] {
    guard let connect else { return [] }
    let records: [ConnectPhoneRecord]
    do {
      records = try await connect.relay.phones()
    } catch {
      await connectHandleRemoval(error)
      throw error
    }
    let phones = records.map { record in
      ConnectPhone(
        id: record.deviceId,
        label: record.label,
        model: record.model,
        appVersion: record.appVersion,
        iosMajorVersion: record.iosMajorVersion,
        isDevBuild: record.bundleId?.hasSuffix(".dev") == true,
        lastSeen: Self.parseDate(record.lastSeenAt),
        isThisPhone: record.current || record.deviceId == connect.deviceId
      )
    }
    return ConnectPhone.ordered(phones)
  }

  public func connectRemovePhone(_ phoneId: String) async throws {
    guard let connect else { return }
    let result: ConnectPhoneRemoval
    do {
      result = try await connect.relay.removePhone(phoneId)
    } catch {
      await connectHandleRemoval(error)
      throw error
    }
    // The relay already ended this phone's session and push registration.
    if result.current || phoneId == connect.deviceId {
      await signOutOfConnect(unregister: false)
    }
  }

  /// The relay refused this phone because it was removed from the account:
  /// sign out here too, forget what Connect gave it and say why, once.
  func connectHandleRemoval(_ error: any Error) async {
    guard let connect, Self.isDeviceRemoved(error), !connect.handlingRemoval, !connect.wasRemoved, !connect.signingOut else { return }
    // Clerk may already have dropped the session the removal ended; the
    // refusal still counts while this phone was signed in. One that lands
    // after the person signed out here is a stale request.
    let signedIn = connect.account.currentUser != nil || model?.connect?.user != nil || connect.wasSignedIn || connect.sessionEndedElsewhere
    guard signedIn else { return }
    connect.handlingRemoval = true
    defer { connect.handlingRemoval = false }
    Self.log.info("This phone was removed from the Connect account; signing out")
    connect.wasRemoved = true
    await signOutOfConnect(unregister: false)
    updateConnect { $0.wasRemoved = true }
  }

  /// Found signed out without the person signing out here. A phone removed
  /// while it was idle comes back to a Clerk session the removal ended, so
  /// ask the relay, by this phone's key alone, whether that is why. Any
  /// failure leaves it plainly signed out.
  func connectSessionEnded() async {
    guard let connect, connect.wasSignedIn, !connect.wasRemoved else { return }
    // Cleared first so overlapping callers ask once.
    connect.wasSignedIn = false
    connect.sessionEndedElsewhere = true
    let removed: Bool
    do {
      removed = try await connect.relay.removalStatus()
    } catch {
      Self.log.error("Removal check failed: \(String(describing: error), privacy: .public)")
      // Without an answer, ask again next time.
      if case ConnectError.unreachable = error { connect.wasSignedIn = true }
      return
    }
    // A device_removed refusal may have handled it meanwhile.
    guard removed, !connect.wasRemoved else { return }
    Self.log.info("This phone was removed from the Connect account while signed out")
    connect.wasRemoved = true
    await signOutOfConnect(unregister: false)
    updateConnect { $0.wasRemoved = true }
  }

  /// The relay refused this phone's Clerk session even after a fresh token,
  /// from the account screen or from any computer reached through Connect.
  /// Clerk's saved user is only a cache: it is cleared too, so this phone
  /// shows signed out everywhere, now and after the next launch, until the
  /// person signs in again. Computers stay listed and reconnect then.
  func connectSessionRejected() async {
    guard let connect, !connect.signingOut, !connect.handlingRemoval, !connect.wasRemoved, !connect.rejectingSession else { return }
    guard connect.account.currentUser != nil || model?.connect?.user != nil else { return }
    connect.rejectingSession = true
    defer { connect.rejectingSession = false }
    Self.log.info("Connect session rejected; showing signed out")
    connect.wasSignedIn = true
    connect.lastRefresh = Date()
    updateConnect { $0.user = nil; $0.lastError = nil }
    connect.signingOut = true
    do {
      try await connect.account.signOut()
    } catch {
      Self.log.error("Clearing the rejected session failed: \(String(describing: error), privacy: .public)")
    }
    connect.signingOut = false
    await connectSessionEnded()
  }

  public func connectDeleteAccount() async throws {
    guard let connect else { return }
    updateConnect { $0.isBusy = true; $0.lastError = nil }
    defer { updateConnect { $0.isBusy = false } }
    // The relay removes this phone's push registration with the account.
    do {
      let result = try await connect.relay.deleteAccount()
      Self.log.info("Account deleted; \(result.environmentCount, privacy: .public) computers unlinked")
    } catch {
      updateConnect { $0.lastError = error.localizedDescription }
      throw error
    }
    connect.registeredPush = nil
    connect.wasSignedIn = false
    connect.sessionEndedElsewhere = false
    connect.signingOut = true
    defer { connect.signingOut = false }
    do {
      try await connect.account.signOut()
    } catch {
      Self.log.error("Sign out after deletion failed: \(String(describing: error), privacy: .public)")
    }
    await forgetConnect()
  }

  public func connectRefresh() async {
    guard let connect else { return }
    if let running = connect.refreshTask { return await running.value }
    let task = Task { await performConnectRefresh(connect) }
    connect.refreshTask = task
    await task.value
    connect.refreshTask = nil
  }

  /// Lists the computers again when the app returns after a minute or more.
  /// Clerk signed out while the app was running is noticed here too, at once
  /// the first time; a check the relay could not answer is retried at most
  /// once a minute.
  func refreshConnectIfStale() {
    guard let connect else { return }
    let dropped = connect.account.currentUser == nil
    if dropped, !connectSessionDropped(connect) { return }
    let firstNotice = dropped && model?.connect?.user != nil
    if !firstNotice, let last = connect.lastRefresh, Date().timeIntervalSince(last) < Self.refreshInterval { return }
    Task { await connectRefresh() }
  }

  /// Clerk is signed out though this phone still counted as signed in and
  /// the person did not sign out here.
  func connectSessionDropped(_ connect: ConnectRuntime) -> Bool {
    connect.account.currentUser == nil && !connect.signingOut && !connect.handlingRemoval && !connect.wasRemoved
      && (connect.wasSignedIn || model?.connect?.user != nil)
  }

  private func performConnectRefresh(_ connect: ConnectRuntime) async {
    guard connect.account.currentUser != nil else {
      guard connectSessionDropped(connect) else { return }
      Self.log.info("Connect session ended while running")
      connect.lastRefresh = Date()
      // Shown signed out now; `connectSessionEnded` asks the relay once.
      if model?.connect?.user != nil { connect.wasSignedIn = true }
      updateConnect { $0.user = nil }
      await connectSessionEnded()
      return
    }
    updateConnect { $0.isBusy = $0.macs.isEmpty }
    defer { updateConnect { $0.isBusy = false } }
    let environments: [ConnectEnvironment]
    do {
      environments = try await connect.relay.environments()
    } catch {
      if Self.isDeviceRemoved(error) {
        await connectHandleRemoval(error)
        return
      }
      if Self.isSignedOut(error) {
        await connectSessionRejected()
      } else {
        updateConnect { $0.lastError = error.localizedDescription }
      }
      return
    }
    connect.lastRefresh = Date()
    await adoptConnectEnvironments(environments)
    updateConnect { state in
      let known = Dictionary(state.macs.map { ($0.id, $0.isOnline) }, uniquingKeysWith: { first, _ in first })
      state.lastError = nil
      state.macs = environments.map { env in
        ConnectMac(id: env.environmentId, label: env.label, isOnline: known[env.environmentId] ?? nil, checkedAt: connect.checkedAt[env.environmentId])
      }
    }
    publishNow()
    await refreshConnectStatuses(environments.map(\.environmentId))
  }

  /// Adds the account's computers and stops reaching removed ones through Connect.
  func adoptConnectEnvironments(_ environments: [ConnectEnvironment]) async {
    let listed = Set(environments.map(\.environmentId))
    for environment in environments {
      guard let route = ConnectAuthorizer.route(for: environment.endpoint) else { continue }
      let env = environment.environmentId
      let changed = machines[env]?.record.connectRoute != route
      var record: MachineRecord
      do {
        record = try await registry.recordConnect(environmentId: env, label: environment.label, route: route)
      } catch {
        Self.log.error("Could not save \(env, privacy: .public): \(String(describing: error), privacy: .public)")
        continue
      }
      if let entry = machines[env] {
        // Local intent wins even if this actor result was queued before Disconnect.
        record.enabled = entry.record.enabled
        entry.record = record
        await entry.connection.update(record)
        if changed { await entry.connection.reconnect() }
      } else {
        addMachine(record, credential: nil)
      }
    }
    for record in await registry.all() where record.connectRoute != nil && !listed.contains(record.environmentId) {
      await dropConnectRoute(record)
    }
  }

  private func refreshConnectStatuses(_ ids: [String]) async {
    guard let connect else { return }
    let relay = connect.relay
    // One task per computer, each awaited here. Not a task group: on the
    // iPhone a main-actor task group let this function return while a status
    // request was still running, and that child then completed into the
    // freed group and crashed the app at launch.
    let checks = ids.map { id in
      (id, Task.detached { () -> Result<ConnectEnvironmentStatus, any Error> in
        do { return .success(try await relay.status(of: id)) } catch { return .failure(error) }
      })
    }
    var results: [String: ConnectEnvironmentStatus] = [:]
    var removal: (any Error)?
    await withTaskCancellationHandler {
      for (id, check) in checks {
        switch await check.value {
        case let .success(status): results[id] = status
        case let .failure(error): if Self.isDeviceRemoved(error) { removal = error }
        }
      }
    } onCancel: {
      for (_, check) in checks { check.cancel() }
    }
    if let removal {
      await connectHandleRemoval(removal)
      return
    }
    for (id, status) in results {
      connect.checkedAt[id] = Self.parseDate(status.checkedAt) ?? Date()
      // An online computer reconnects now instead of after its backoff.
      if status.isOnline, let entry = machines[id], entry.status.state != .connected {
        let connection = entry.connection
        Task { await connection.reconnect() }
      }
    }
    updateConnect { state in
      for index in state.macs.indices {
        guard let status = results[state.macs[index].id] else { continue }
        state.macs[index].isOnline = status.isOnline
        state.macs[index].checkedAt = connect.checkedAt[state.macs[index].id]
      }
    }
    publishNow()
  }

  /// Forgets everything the account gave this phone.
  func forgetConnect() async {
    guard let connect else { return }
    for record in await registry.all() where record.connectRoute != nil {
      await dropConnectRoute(record)
    }
    await connect.authorizer.forget(Array(machines.keys))
    await connect.relay.reset()
    connect.checkedAt = [:]
    connect.lastRefresh = nil
    updateConnect { $0.user = nil; $0.macs = []; $0.lastError = nil }
    publishNow()
  }

  /// A computer paired directly keeps its pairing; one known only through
  /// Connect is removed.
  private func dropConnectRoute(_ record: MachineRecord) async {
    let env = record.environmentId
    guard !record.routes.isEmpty else {
      if machines[env] != nil { removeMachine(id: env) } else { _ = try? await registry.remove(env) }
      return
    }
    guard var updated = try? await registry.update(env, { $0.connectRoute = nil }) else { return }
    if let entry = machines[env] {
      updated.enabled = entry.record.enabled
      entry.record = updated
      await entry.connection.update(updated)
      await entry.connection.reconnect()
    }
  }

  func updateConnect(_ change: (inout ConnectState) -> Void) {
    guard let model, var state = model.connect else { return }
    change(&state)
    if state != model.connect { model.connect = state }
  }

  static func isSignedOut(_ error: any Error) -> Bool {
    switch error {
    case ConnectError.signedOut, TransportError.connect(.signedOut): true
    default: false
    }
  }

  static func isDeviceRemoved(_ error: any Error) -> Bool {
    switch error {
    case let error as ConnectError: error.isDeviceRemoved
    case let TransportError.connect(error): error.isDeviceRemoved
    default: false
    }
  }

  static func parseDate(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: string) ?? ISO8601DateFormatter().date(from: string)
  }
}
