import SwiftUI

/// Machine and thread states that Weave can draw.
public nonisolated enum WeaveStatus: String, Sendable, CaseIterable {
  case online, offline, connecting, working, needsYou, failed, idle

  public var label: String {
    switch self {
    case .online: "Online"
    case .offline: "Offline"
    case .connecting: "Connecting"
    case .working: "Working"
    case .needsYou: "Needs you"
    case .failed: "Failed"
    case .idle: "Idle"
    }
  }

  public var color: Color {
    switch self {
    case .online: .weave.pass
    case .offline, .idle: .weave.control
    case .connecting, .needsYou: .weave.warn
    case .working: .weave.iris
    case .failed: .weave.fail
    }
  }
}

/// A small status dot. Offline and idle are hollow so they do not rely on hue alone.
public struct StatusDot: View {
  let status: WeaveStatus
  let size: CGFloat
  let ringColor: Color?

  /// - Parameter ringColor: Draws a ring in this color around the dot, to cut
  ///   it out of an icon it overlaps.
  public init(_ status: WeaveStatus, size: CGFloat = 8, ringColor: Color? = nil) {
    self.status = status
    self.size = size
    self.ringColor = ringColor
  }

  public var body: some View {
    ZStack {
      if let ringColor {
        Circle().fill(ringColor).frame(width: size + 3, height: size + 3)
      }
      if status == .offline || status == .idle {
        Circle().strokeBorder(status.color, lineWidth: max(1.2, size * 0.2)).frame(width: size, height: size)
      } else {
        Circle().fill(status.color).frame(width: size, height: size)
      }
    }
    .accessibilityElement()
    .accessibilityLabel(status.label)
  }
}

/// A laptop glyph with a status dot, for "which machine, is it online".
public struct MachineBadge: View {
  let status: WeaveStatus
  let label: String?
  let systemName: String
  let size: CGFloat

  /// - Parameter label: The machine name, shown after the glyph when given.
  public init(status: WeaveStatus, label: String? = nil, systemName: String = "laptopcomputer", size: CGFloat = 16) {
    self.status = status
    self.label = label
    self.systemName = systemName
    self.size = size
  }

  public var body: some View {
    HStack(spacing: WeaveSpacing.s1 + 2) {
      Image(systemName: systemName)
        .font(.system(size: size, weight: .regular))
        .foregroundStyle(Color.weave.muted)
        .overlay(alignment: .bottomTrailing) {
          StatusDot(status, size: max(5, size * 0.36), ringColor: .weave.canvas)
            .offset(x: size * 0.2, y: size * 0.12)
        }
      if let label {
        Text(label)
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .lineLimit(1)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label.map { "\($0), \(status.label)" } ?? status.label)
  }
}

#Preview("Light") {
  StatusDotPreview().weavePreview(.light)
}

#Preview("Dark") {
  StatusDotPreview().weavePreview(.dark)
}

private struct StatusDotPreview: View {
  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s4) {
      HStack(spacing: WeaveSpacing.s3) {
        ForEach(WeaveStatus.allCases, id: \.self) { status in
          VStack(spacing: WeaveSpacing.s1) {
            StatusDot(status, size: 10)
            Text(status.label).font(.weave(.footnote)).foregroundStyle(Color.weave.muted)
          }
        }
      }
      HStack(spacing: WeaveSpacing.s6) {
        MachineBadge(status: .online)
        MachineBadge(status: .offline)
        MachineBadge(status: .online, label: "M4")
        MachineBadge(status: .connecting, label: "Office")
      }
    }
  }
}
