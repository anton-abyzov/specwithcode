import SwiftUI

/// The spark that greets an empty conversation. It turns and settles into
/// place once when it appears; it never loops, so an idle screen costs no
/// frames. Under Reduce Motion it simply fades in.
public struct WeaveSpark: View {
  let size: CGFloat
  @State private var settled = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  public init(size: CGFloat = 48) { self.size = size }

  public var body: some View {
    Image("weave-spark", bundle: .module)
      .resizable()
      .interpolation(.high)
      .scaledToFit()
      .frame(width: size, height: size)
      .scaleEffect(settled || reduceMotion ? 1 : 0.55)
      .rotationEffect(.degrees(settled || reduceMotion ? 0 : -50))
      .opacity(settled ? 1 : 0)
      .onAppear {
        withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.7, dampingFraction: 0.62)) { settled = true }
      }
      .accessibilityHidden(true)
  }
}

#Preview {
  WeaveSpark(size: 64)
    .padding(40)
    .background(Color.weave.canvas)
}
