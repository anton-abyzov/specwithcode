import Foundation

/// Sample data for the fleet scenarios: one project linked across M4 and
/// Minis, with M4's coordinator active and one thread that lives on M4 and
/// runs on Minis.
enum FixtureFleet {
  static let m4 = "env-m4"
  static let minis = "env-minis"

  static let onM4 = ProjectRef(environmentId: m4, projectId: "specweave")
  static let onMinis = ProjectRef(environmentId: minis, projectId: "specweave")

  static let machines: [MachineSummary] = [
    MachineSummary(id: m4, label: "M4", status: .connected, platform: "macOS · arm64", serverVersion: "1.0.63", address: "http://192.168.1.20:3773", tokenDaysLeft: 28),
    MachineSummary(id: minis, label: "Minis", status: .connected, platform: "macOS · arm64", serverVersion: "1.0.63", address: "http://192.168.1.30:3773", tokenDaysLeft: 28),
  ]

  static let project = ProjectSummary(
    ref: onM4,
    title: "SpecWeave",
    icon: .symbol(name: "dna", color: "amber"),
    machineLabel: "M4",
    machineOnline: true,
    isPinned: true,
    members: [
      ProjectMember(ref: onM4, machineLabel: "M4", machineOnline: true, isCoordinator: true),
      ProjectMember(ref: onMinis, machineLabel: "Minis", machineOnline: true),
    ]
  )

  /// Threads that run on another machine than the one they live on.
  static let runsOn: [ThreadRef: String] = [
    ThreadRef(environmentId: m4, threadId: "f-windows"): minis,
  ]

  static func threads(now: Date) -> [ThreadSummary] {
    func ago(_ minutes: Double) -> Date { now.addingTimeInterval(-minutes * 60) }
    func thread(_ id: String, on machine: String, _ title: String, _ activity: ThreadActivity, _ preview: String, updated: Double, started: Double? = nil, unread: Bool = false, plan: (Int, Int)? = nil) -> ThreadSummary {
      let ref = ThreadRef(environmentId: machine, threadId: id)
      let label = machine == m4 ? "M4" : "Minis"
      return ThreadSummary(
        ref: ref,
        projectRef: onM4,
        projectTitle: "SpecWeave",
        title: title,
        activity: activity,
        preview: preview,
        updatedAt: ago(updated),
        workStartedAt: started.map(ago),
        isUnread: unread,
        machineLabel: label,
        machineOnline: true,
        planProgress: plan.map { PlanProgress(completed: $0.0, total: $0.1) },
        placement: ThreadPlacement(owner: label, runsOn: runsOn[ref].map { $0 == m4 ? "M4" : "Minis" })
      )
    }
    return [
      thread("f-release", on: m4, "Release checklist", .needsYou, "Wants to run the release script", updated: 1, started: 7, unread: true, plan: (2, 4)),
      thread("f-phone", on: m4, "Phone keeps working when M4 is off", .working, "Running the fleet tests", updated: 0.5, started: 12, plan: (6, 10)),
      thread("f-windows", on: m4, "Windows installer", .working, "Building the MSI on Minis", updated: 2, started: 30, plan: (3, 7)),
      thread("f-linux", on: minis, "Linux packages", .working, "Signing the .deb", updated: 3, started: 18, plan: (2, 5)),
      thread("f-docs", on: minis, "Docs for machine nicknames", .idle, "Draft ready for review", updated: 45),
    ]
  }
}
