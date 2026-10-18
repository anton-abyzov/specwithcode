import SwiftUI

/// A pass, warn or fail chip. Always carries a word; fail also carries an icon
/// so it never depends on color alone.
public struct StatusChip: View {
  public enum Kind: Sendable {
    case pass, warn, fail, neutral
  }

  let kind: Kind
  let text: String

  public init(_ text: String, kind: Kind) {
    self.text = text
    self.kind = kind
  }

  public var body: some View {
    HStack(spacing: WeaveSpacing.s1) {
      if kind == .fail {
        Image(systemName: "xmark.octagon.fill")
          .font(.system(size: 11, weight: .semibold))
          .accessibilityHidden(true)
      }
      Text(text)
        .font(.weave(.caption, weight: .medium))
        .lineLimit(1)
    }
    .foregroundStyle(foreground)
    .padding(.horizontal, WeaveSpacing.s2)
    .padding(.vertical, 3)
    .background(background, in: RoundedRectangle(cornerRadius: WeaveRadius.sm, style: .continuous))
    .accessibilityElement(children: .combine)
  }

  private var foreground: Color {
    switch kind {
    case .pass: .weave.pass
    case .warn: .weave.warn
    case .fail: .weave.fail
    case .neutral: .weave.muted
    }
  }

  private var background: Color {
    switch kind {
    case .pass: .weave.passTint
    case .warn: .weave.warnTint
    case .fail: .weave.failTint
    case .neutral: .weave.sunken
    }
  }
}

/// A determinate progress ring.
public struct ProgressRing: View {
  let progress: Double
  let size: CGFloat
  let lineWidth: CGFloat

  public init(progress: Double, size: CGFloat = 18, lineWidth: CGFloat = 2.5) {
    self.progress = progress
    self.size = size
    self.lineWidth = lineWidth
  }

  public var body: some View {
    ZStack {
      Circle().stroke(Color.weave.line, lineWidth: lineWidth)
      Circle()
        .trim(from: 0, to: min(max(progress, 0), 1))
        .stroke(Color.weave.iris, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .frame(width: size, height: size)
    .animation(.easeInOut(duration: 0.3), value: progress)
    .accessibilityHidden(true)
  }
}

/// The floating "2/5 tasks" capsule with a progress ring.
public struct TasksChip: View {
  let completed: Int
  let total: Int
  let action: (() -> Void)?

  public init(completed: Int, total: Int, action: (() -> Void)? = nil) {
    self.completed = completed
    self.total = total
    self.action = action
  }

  public var body: some View {
    Group {
      if let action {
        Button(action: action) { chip }.buttonStyle(WeavePressStyle())
      } else {
        chip
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(completed) of \(total) tasks done")
  }

  private var chip: some View {
    HStack(spacing: WeaveSpacing.s2) {
      ProgressRing(progress: total > 0 ? Double(completed) / Double(total) : 0)
      Text("\(completed)/\(total) tasks")
        .font(.weave(.callout, weight: .semibold))
        .foregroundStyle(Color.weave.ink)
        .monospacedDigit()
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .frame(minHeight: 41)
    .weaveGlass(in: Capsule(), interactive: action != nil)
    .frame(minHeight: WeaveSize.minTap)
    .contentShape(Capsule())
  }
}

#Preview("Light") {
  StatusChipPreview().weavePreview(.light)
}

#Preview("Dark") {
  StatusChipPreview().weavePreview(.dark)
}

private struct StatusChipPreview: View {
  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      HStack {
        StatusChip("Passed", kind: .pass)
        StatusChip("Stale", kind: .warn)
        StatusChip("Failed", kind: .fail)
        StatusChip("Queued", kind: .neutral)
      }
      TasksChip(completed: 2, total: 5) {}
      TasksChip(completed: 5, total: 5)
    }
  }
}
