import SwiftUI
import SWCSync
import Weave

/// Provider above its model's vendor mark; the adjacent text names both explicitly.
struct ThreadIdentityMarks: View {
  let identity: ThreadIdentity
  var body: some View {
    VStack(spacing: 6) {
      ProviderMark(identity.providerBrand, size: 22)
      ProviderMark(identity.modelBrand, size: 14)
    }
    .frame(width: 28)
    .accessibilityHidden(true)
  }
}
