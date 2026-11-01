import SwiftUI

/// The SpecWithCode mark: the spec page with a prompt on its indigo tile.
/// Used where the wordmark would be cut off, such as a narrow sidebar.
public struct WeaveLogo: View {
  let size: CGFloat

  public init(size: CGFloat = 32) { self.size = size }

  public var body: some View {
    Image("specwithcode-logo", bundle: .module)
      .resizable()
      .interpolation(.high)
      .scaledToFit()
      .frame(width: size, height: size)
      .accessibilityLabel("SpecWithCode")
  }
}

#Preview {
  WeaveLogo(size: 64)
}
