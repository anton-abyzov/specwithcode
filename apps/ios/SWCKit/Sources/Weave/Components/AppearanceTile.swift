import SwiftUI

/// One appearance choice drawn as a small window preview. System is split
/// diagonally between light and dark. The selected tile gets an iris border.
public struct AppearanceTile: View {
  public enum Kind: String, Sendable, CaseIterable, Identifiable {
    case light, dark, system

    public var id: String { rawValue }

    public var label: String {
      switch self {
      case .light: "Light"
      case .dark: "Dark"
      case .system: "System"
      }
    }
  }

  let kind: Kind
  let isSelected: Bool
  let action: () -> Void

  public init(kind: Kind, isSelected: Bool, action: @escaping () -> Void) {
    self.kind = kind
    self.isSelected = isSelected
    self.action = action
  }

  public var body: some View {
    Button(action: action) {
      VStack(spacing: WeaveSpacing.s2) {
        preview
          .aspectRatio(1.5, contentMode: .fit)
          .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous)
              .strokeBorder(isSelected ? Color.weave.iris : Color.weave.line, lineWidth: isSelected ? 2 : 1)
          )
        Text(kind.label)
          .font(.weave(.callout, weight: isSelected ? .semibold : .regular))
          .foregroundStyle(isSelected ? Color.weave.iris : Color.weave.muted)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(WeavePressStyle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(kind.label) appearance")
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
  }

  @ViewBuilder private var preview: some View {
    switch kind {
    case .light:
      MiniWindow(appearance: .light)
    case .dark:
      MiniWindow(appearance: .dark)
    case .system:
      ZStack {
        MiniWindow(appearance: .light)
        MiniWindow(appearance: .dark)
          .clipShape(DiagonalHalf())
      }
    }
  }
}

/// A row of Light, Dark and System tiles bound to an appearance string.
public struct AppearancePicker: View {
  @Binding var selection: String

  public init(selection: Binding<String>) { self._selection = selection }

  public var body: some View {
    HStack(spacing: WeaveSpacing.s3) {
      ForEach(AppearanceTile.Kind.allCases) { kind in
        AppearanceTile(kind: kind, isSelected: selection == kind.rawValue) { selection = kind.rawValue }
      }
    }
  }
}

/// A fixed-palette sketch of the app in one appearance.
private struct MiniWindow: View {
  let appearance: WeaveAppearance

  var body: some View {
    GeometryReader { proxy in
      let w = proxy.size.width, h = proxy.size.height
      ZStack(alignment: .topLeading) {
        token(.canvas)
        RoundedRectangle(cornerRadius: 6, style: .continuous)
          .fill(token(.panel))
          .frame(width: w * 0.78, height: h * 0.62)
          .offset(x: w * 0.11, y: h * 0.2)
        VStack(alignment: .leading, spacing: h * 0.09) {
          Capsule().fill(token(.ink).opacity(0.75)).frame(width: w * 0.42, height: max(3, h * 0.07))
          Capsule().fill(token(.muted).opacity(0.6)).frame(width: w * 0.56, height: max(3, h * 0.07))
          Circle().fill(token(.iris)).frame(width: h * 0.13, height: h * 0.13)
        }
        .offset(x: w * 0.2, y: h * 0.32)
      }
    }
  }

  private func token(_ token: WeaveColorToken) -> Color {
    let rgb = token.rgb(appearance)
    return Color(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue)
  }
}

/// The lower-right triangle of a rectangle.
private nonisolated struct DiagonalHalf: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
    p.closeSubpath()
    return p
  }
}

#Preview("Light") {
  AppearancePickerPreview().weavePreview(.light)
}

#Preview("Dark") {
  AppearancePickerPreview().weavePreview(.dark)
}

private struct AppearancePickerPreview: View {
  @State private var selection = "system"

  var body: some View {
    AppearancePicker(selection: $selection)
  }
}
