import Foundation
import SWCTransport
import SWCWire

/// The phone pairs once with one machine and reaches the rest of its fleet,
/// so any one machine being off leaves the others usable. Thread lists are
/// kept on the phone, so an unreachable machine's threads stay listed.
extension LiveEngine {
  // MARK: - Saved thread lists

  func loadFleetCache() async {
    guard let fleetCache else { return }
    fleetNames = await fleetCache.labels()
    if let saved = await fleetCache.savedHome() {
      fleetHome = saved
    } else if let first = Self.firstPairedByHand(machineOrder.compactMap { machines[$0]?.record }) {
      // An install from before home machines were kept: the first machine
      // paired by hand is the one the person started from.
      fleetHome = [first]
      await fleetCache.setHome(fleetHome)
    }
    for entry in machines.values {
      let cached = await fleetCache.cached(entry.environmentId)
      if entry.snapshot == nil { entry.cachedSnapshot = cached.snapshot }
      if entry.lastSeenAt == nil { entry.lastSeenAt = cached.lastSeenAt }
      entry.cachedAideEnabled = cached.aideEnabled
    }
  }

  /// Saves the machine's Aide switch when it changes, for the next cold start.
  func rememberAide(_ entry: MachineEntry) {
    guard let enabled = entry.settings?.aideEnabled, entry.cachedAideEnabled != enabled else { return }
    entry.cachedAideEnabled = enabled
    guard let fleetCache else { return }
    let env = entry.environmentId
    Task { await fleetCache.setAideEnabled(enabled, for: env) }
  }

  /// The machine was connected until now.
  func markSeen(_ entry: MachineEntry) {
    let now = Date()
    entry.lastSeenAt = now
    guard let fleetCache else { return }
    let env = entry.environmentId
    let snapshot = entry.snapshot
    entry.shellSavedAt = .now
    Task {
      await fleetCache.setLastSeen(now, for: env)
      if let snapshot { await fleetCache.saveSnapshot(snapshot, for: env) }
    }
  }

  /// Saves a live thread list at most once per `shellSaveInterval`.
  func saveShellIfDue(_ entry: MachineEntry) {
    if let saved = entry.shellSavedAt, ContinuousClock.now - saved < options.shellSaveInterval { return }
    markSeen(entry)
  }

  func saveFleetCache() {
    for entry in machines.values where entry.isOnline && entry.snapshot != nil {
      markSeen(entry)
    }
  }

  // MARK: - Linking the fleet

  /// Asks a connected machine which other machines share its fleet, and pairs
  /// with the ones this phone cannot reach yet using codes that machine mints.
  /// A machine the person removed is never paired again this way.
  func linkFleet(via entry: MachineEntry) async {
    guard let fleetCache, !fleetLinking, entry.record.enabled, let socket = entry.socket else { return }
    let env = entry.environmentId
    if let last = fleetLinkedAt[env], ContinuousClock.now - last < options.fleetLinkInterval { return }
    // A Connect token is bound to the device key and only goes to the tunnel.
    // Config can arrive before the independent status-stream consumer. Read
    // the route from the live socket's owner, or fleet discovery can be lost.
    guard let route = await entry.connection.route(of: socket),
          !fleetLinking, machines[env] === entry, entry.record.enabled, entry.socket === socket,
          route.issuer != ConnectAuthorizer.issuer,
          let credential = try? credentials.credential(for: route, of: env), !credential.isExpired() else { return }
    fleetLinking = true
    fleetLinkedAt[env] = .now
    defer { fleetLinking = false }

    let roster: PhoneRoster
    do {
      roster = try await http.phoneRoster(token: credential.token, at: route.httpBase)
    } catch {
      Self.log.info("No fleet roster from \(env, privacy: .public): \(String(describing: error), privacy: .public)")
      return
    }
    await remember(roster, fleetCache)
    let dismissed = await fleetCache.dismissed()
    let wanted = roster.machines.filter { needsLink($0, hub: roster.hub.environmentId, dismissed: dismissed) }.map(\.environmentId)
    guard !wanted.isEmpty else { return }

    let minted: PhoneRoster
    do {
      minted = try await http.phoneRoster(token: credential.token, at: route.httpBase, mint: wanted)
    } catch {
      Self.log.error("Fleet codes failed on \(env, privacy: .public): \(String(describing: error), privacy: .public)")
      return
    }
    var linked = false
    for machine in minted.machines where wanted.contains(machine.environmentId) {
      guard let pairing = machine.pairing else {
        Self.log.info("\(machine.environmentId, privacy: .public) not linked: \(machine.problem ?? "no code", privacy: .public)")
        continue
      }
      if await redeem(machine, code: pairing.code) { linked = true }
    }
    if linked {
      // Machines just linked are known now, so a Tailscale one becomes home at once.
      for env in Self.homeFromRoster(roster, home: fleetHome) { await markHome(env) }
      publishNow()
    }
  }

  /// Lists the machine's projects, as the desktop app lists its own machine's.
  func markHome(_ environmentId: String) async {
    guard !fleetHome.contains(environmentId), machines[environmentId] != nil else { return }
    fleetHome.insert(environmentId)
    await fleetCache?.addHome(environmentId)
    schedulePublish()
  }

  /// The first saved machine with a route the person paired, not one learned
  /// or reached only through Connect.
  static func firstPairedByHand(_ records: [MachineRecord]) -> String? {
    records.first { record in record.routes.contains { !$0.learned && $0.issuer != ConnectAuthorizer.issuer } }?.environmentId
  }

  /// Machines a roster makes home. Every machine with a phone session answers
  /// a roster naming itself as hub, workers included, so the hub counts only
  /// while the phone has no home yet. A home hub's machines with a Tailscale
  /// address count too: the desktop pairs those by itself and lists their
  /// projects (`fleetMachineHasTailnetAddress` on the web).
  static func homeFromRoster(_ roster: PhoneRoster, home: Set<String>) -> [String] {
    let hub = roster.hub.environmentId
    guard home.isEmpty || home.contains(hub) else { return [] }
    let tailnet = roster.machines.filter { machine in
      machine.problem == nil && machine.routes.contains { URL(string: $0.httpBaseUrl)?.host()?.lowercased().hasSuffix(".ts.net") == true }
    }
    return [hub] + tailnet.map(\.environmentId)
  }

  func needsLink(_ machine: PhoneRoster.Machine, hub: String, dismissed: Set<String>) -> Bool {
    let env = machine.environmentId
    guard env != hub, machine.problem == nil, !machine.routes.isEmpty, !dismissed.contains(env) else { return false }
    guard let entry = machines[env] else { return true }
    guard entry.record.enabled else { return false }
    if entry.status.state == .needsRepair { return true }
    return credentials.bestCredential(for: entry.record) == nil && entry.record.connectRoute == nil
  }

  /// Spends a code on the first route that answers as that machine; the
  /// descriptor is checked first, so an unreachable route leaves the code usable.
  func redeem(_ machine: PhoneRoster.Machine, code: String) async -> Bool {
    let pairing = MachinePairing(http: http, credentials: credentials, registry: registry)
    for route in machine.routes {
      guard let origin = try? PairingLink.origin(of: route.httpBaseUrl),
            (try? await http.descriptor(at: origin.httpBase, expectedEnvironmentId: machine.environmentId)) != nil else { continue }
      do {
        let result = try await pairing.pair(target: PairingTarget(code: code, httpBase: origin.httpBase, wsBase: origin.wsBase), clientLabel: options.clientLabel(), expectedEnvironmentId: machine.environmentId, resumeConnection: false)
        _ = await adopt(result, resumeConnection: false)
        return true
      } catch {
        Self.log.error("Linking \(machine.environmentId, privacy: .public) failed: \(String(describing: error), privacy: .public)")
        return false
      }
    }
    Self.log.info("No route answered for \(machine.environmentId, privacy: .public)")
    return false
  }

  private func remember(_ roster: PhoneRoster, _ fleetCache: FleetCache) async {
    for env in Self.homeFromRoster(roster, home: fleetHome) { await markHome(env) }
    var names = [roster.hub.environmentId: roster.hub.label]
    for machine in roster.machines { names[machine.environmentId] = machine.label }
    guard names.contains(where: { fleetNames[$0.key] != $0.value }) else { return }
    fleetNames.merge(names) { _, new in new }
    await fleetCache.setLabels(names)
    schedulePublish()
  }
}
