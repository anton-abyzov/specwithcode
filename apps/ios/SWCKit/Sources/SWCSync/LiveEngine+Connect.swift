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
  /// The account and token of the registration the relay accepted.
  var registeredPush: String?

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
    let bridge = ConnectSessionBridge { [account] refresh in try await account.sessionToken(refresh: refresh) }
    relay = RelayClient(config: account.config, session: bridge, keys: keys, transport: transport)
    deviceId = Self.deviceId(defaults)
    authorizer = ConnectAuthorizer(relay: relay, credentials: credentials, http: http, deviceId: deviceId, clientLabel: clientLabel)
  }

  static let deviceIdKey = "SWCConnectDeviceId"

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
      await connectRefresh()
      await connectAfterSignIn()
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
    updateConnect { $0.user = connect.account.currentUser }
    await connectRefresh()
    await connectAfterSignIn()
  }

  public func connectSignOut() async {
    guard let connect else { return }
    updateConnect { $0.isBusy = true }
    await connectBeforeSignOut()
    do {
      try await connect.account.signOut()
    } catch {
      Self.log.error("Sign out failed: \(String(describing: error), privacy: .public)")
    }
    await forgetConnect()
    updateConnect { $0.isBusy = false }
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
  func refreshConnectIfStale() {
    guard let connect, connect.account.currentUser != nil else { return }
    if let last = connect.lastRefresh, Date().timeIntervalSince(last) < Self.refreshInterval { return }
    Task { await connectRefresh() }
  }

  private func performConnectRefresh(_ connect: ConnectRuntime) async {
    guard connect.account.currentUser != nil else { return }
    updateConnect { $0.isBusy = $0.macs.isEmpty }
    defer { updateConnect { $0.isBusy = false } }
    let environments: [ConnectEnvironment]
    do {
      environments = try await connect.relay.environments()
    } catch {
      if Self.isSignedOut(error) {
        updateConnect { $0.user = nil }
      }
      updateConnect { $0.lastError = error.localizedDescription }
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
    let results = await withTaskGroup(of: (String, ConnectEnvironmentStatus?).self) { group in
      for id in ids {
        group.addTask { (id, try? await relay.status(of: id)) }
      }
      var results: [String: ConnectEnvironmentStatus] = [:]
      for await (id, status) in group { if let status { results[id] = status } }
      return results
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
  private func forgetConnect() async {
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

  static func parseDate(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return fractional.date(from: string) ?? ISO8601DateFormatter().date(from: string)
  }
}
