import XCTest

/// Walks every launch route and checks each control on screen: at least
/// 44 x 44 pt, and a spoken label on every button. Collects every problem
/// before failing, and attaches a screenshot and a report per screen.
@MainActor
final class HitTargetAuditUITests: SWCUITestCase {
  private static let minSide: CGFloat = 44
  /// One device pixel at 3x, so a 44 pt control rounded to 43.67 still passes.
  private static let tolerance: CGFloat = 0.34
  private static let auditedTypes: Set<XCUIElement.ElementType> = [.button, .link, .switch, .toggle, .textField, .secureTextField, .textView]

  private struct Candidate {
    let type: XCUIElement.ElementType
    /// Position among elements of the same type, in query order.
    let index: Int
    let label: String
    let frame: CGRect
    /// Inside another control, so VoiceOver reaches it only through that control.
    let nested: Bool
  }

  private struct Screen {
    let name: String
    let open: () -> Void
  }

  private struct Violation {
    let screen: String
    let type: XCUIElement.ElementType
    let label: String
    let line: String
  }

  func testHitTargetsAndLabelsOnEveryRoute() throws {
    let screens: [Screen] = [
      Screen(name: "home") {
        self.launch()
        self.waitForHome()
      },
      Screen(name: "drawer") {
        self.launch()
        self.waitForHome()
        self.openDrawer()
      },
      Screen(name: "overview") {
        self.launch(route: "overview")
        self.waitForHittable(self.button("Search threads"))
      },
      Screen(name: "thread") {
        self.launch(route: "thread")
        self.waitForHittable(self.button("Thread actions"))
        self.waitForHittable(self.button("Approve"))
      },
      Screen(name: "settings") {
        self.launch(route: "settings")
        self.waitForHittable(self.button("Light appearance"))
      },
      Screen(name: "projectSettings") {
        self.launch(route: "projectSettings")
        self.waitForHittable(self.field("Goal"))
      },
      Screen(name: "machines") {
        self.launch(route: "machines")
        self.waitForHittable(self.button("Pair a machine"))
      },
      Screen(name: "pair") {
        self.launch(route: "pair")
        self.waitForHittable(self.button("Connect"))
      },
      Screen(name: "welcome (empty)") {
        self.launch(fixture: "empty")
        self.waitForHittable(self.button("Pair a machine"))
      },
      Screen(name: "sample data") {
        self.launch(fixture: "empty")
        self.tap(self.button("Explore with sample data"))
        self.waitForHome()
        self.waitForHittable(self.button("Exit sample data"))
      },
    ]

    // Collect everything first; the failures come at the end.
    continueAfterFailure = true
    var sizeViolations: [Violation] = []
    var labelViolations: [Violation] = []
    var notes: [String] = []
    var repeats: [String] = []
    var summary: [String] = []

    for screen in screens {
      screen.open()
      settle()
      attachScreenshot("Audit: \(screen.name)")
      let result = try audit(screen.name)
      sizeViolations += result.size
      labelViolations += result.labels
      notes += result.notes
      repeats += result.repeats
      summary.append("\(screen.name): \(result.checked) hittable controls checked, \(result.size.count) too small, \(result.labels.count) unlabeled")
    }

    var lines: [String] = ["Summary"]
    lines += summary
    lines += ["", "Smaller than 44 x 44 pt (\(sizeViolations.count))"]
    lines += sizeViolations.map(Self.describe)
    lines += ["", "Buttons without a label (\(labelViolations.count))"]
    lines += labelViolations.map(Self.describe)
    lines += ["", "Unlabeled buttons nested in a labeled control, not reachable on their own (\(notes.count))"]
    lines += notes
    lines += ["", "Labels that repeat a part, read twice by VoiceOver (\(repeats.count))"]
    lines += repeats
    let report = lines.joined(separator: "\n")
    let attachment = XCTAttachment(string: report)
    attachment.name = "Hit-target and label audit"
    attachment.lifetime = .keepAlways
    add(attachment)
    print(report)

    let problems = sizeViolations + labelViolations
    if !problems.isEmpty {
      XCTFail("\(problems.count) hit-target or label problems:\n" + problems.map(Self.describe).joined(separator: "\n"))
    }
  }

  private static func describe(_ violation: Violation) -> String {
    violation.line
  }

  // MARK: Audit

  private func audit(_ screen: String) throws -> (size: [Violation], labels: [Violation], notes: [String], repeats: [String], checked: Int) {
    let bounds = app.windows.firstMatch.frame
    var counters: [XCUIElement.ElementType: Int] = [:]
    var candidates: [Candidate] = []

    func visit(_ node: XCUIElementSnapshot, nested: Bool) {
      var childrenNested = nested
      if Self.auditedTypes.contains(node.elementType) {
        let index = counters[node.elementType, default: 0]
        counters[node.elementType] = index + 1
        if node.frame.width > 0, node.frame.height > 0, node.frame.intersects(bounds) {
          candidates.append(Candidate(type: node.elementType, index: index, label: node.label, frame: node.frame, nested: nested))
        }
        childrenNested = true
      }
      for child in node.children { visit(child, nested: childrenNested) }
    }
    visit(try app.snapshot(), nested: false)

    var size: [Violation] = []
    var labels: [Violation] = []
    var notes: [String] = []
    var repeats: [String] = []
    var checked = 0
    // Text fields whose touch target is a larger container that focuses them
    // on tap (ComposerUITests proves the composer capsule does).
    let hosts = app.otherElements.matching(identifier: "composer").allElementsBoundByIndex
      .map(\.frame).filter { $0.height + Self.tolerance >= Self.minSide }
    for candidate in candidates {
      guard let element = resolve(candidate), element.isHittable else { continue }
      checked += 1
      let frame = candidate.frame
      let line = "\(screen): \(Self.name(of: candidate.type)) \"\(candidate.label)\" \(Self.format(frame.width)) x \(Self.format(frame.height)) at (\(Self.format(frame.minX)), \(Self.format(frame.minY)))"
      let violation = Violation(screen: screen, type: candidate.type, label: candidate.label, line: line)
      if frame.width + Self.tolerance < Self.minSide || frame.height + Self.tolerance < Self.minSide {
        let isField = [.textField, .textView].contains(candidate.type)
        if isField, hosts.contains(where: { $0.insetBy(dx: -0.5, dy: -0.5).contains(frame) }) {
          notes.append(line + " (touch target is the composer capsule)")
        } else {
          size.append(violation)
        }
      }
      if candidate.type == .button, candidate.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        if candidate.nested { notes.append(line) } else { labels.append(violation) }
      }
      let parts = candidate.label.components(separatedBy: ", ")
      if !candidate.nested, Set(parts).count < parts.count {
        repeats.append(line)
      }
    }
    return (size, labels, notes, repeats, checked)
  }

  /// The live element for a snapshot entry, checked against its frame.
  private func resolve(_ candidate: Candidate) -> XCUIElement? {
    let query = app.descendants(matching: candidate.type)
    let byIndex = query.element(boundBy: candidate.index)
    if byIndex.exists, Self.same(byIndex.frame, candidate.frame), byIndex.label == candidate.label { return byIndex }
    return query.allElementsBoundByIndex.first { $0.label == candidate.label && Self.same($0.frame, candidate.frame) }
  }

  private static func same(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) < 0.5 && abs(a.minY - b.minY) < 0.5 && abs(a.width - b.width) < 0.5 && abs(a.height - b.height) < 0.5
  }

  private static func format(_ value: CGFloat) -> String {
    String(format: "%.1f", Double(value))
  }

  private static func name(of type: XCUIElement.ElementType) -> String {
    switch type {
    case .button: "button"
    case .link: "link"
    case .switch: "switch"
    case .toggle: "toggle"
    case .textField: "text field"
    case .secureTextField: "secure text field"
    case .textView: "text view"
    default: "element \(type.rawValue)"
    }
  }
}
