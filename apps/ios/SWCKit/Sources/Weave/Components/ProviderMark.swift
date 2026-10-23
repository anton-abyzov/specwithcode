import SwiftUI

/// Bundled vector copies of the desktop's official marks. See provider-logos.md.
public struct ProviderMark: View {
  let brand: String?
  let size: CGFloat
  public init(_ brand: String?, size: CGFloat = 22) { self.brand = brand; self.size = size }
  public var body: some View {
    Group {
      if let brand {
        Image(brand, bundle: .module).resizable().scaledToFit()
      } else {
        Image(systemName: "cpu").resizable().scaledToFit().foregroundStyle(Color.weave.muted)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}
