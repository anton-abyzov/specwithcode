import SwiftUI

extension View {
  /// Preview surface: canvas background, gutter and a fixed color scheme.
  func weavePreview(_ scheme: ColorScheme, padding: CGFloat = WeaveSpacing.gutter) -> some View {
    self
      .padding(padding)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background(Color.weave.canvas)
      .foregroundStyle(Color.weave.ink)
      .tint(Color.weave.iris)
      .environment(\.colorScheme, scheme)
  }
}

/// Press feedback shared by Weave buttons: a slight shrink and fade.
struct WeavePressStyle: ButtonStyle {
  var scale: CGFloat = 0.96

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? scale : 1)
      .opacity(configuration.isPressed ? 0.8 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
