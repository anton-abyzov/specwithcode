import SwiftUI
import SWCSync
import Weave

/// The provider mark with its model's vendor as a corner badge when they differ; the adjacent text names both explicitly.
struct ThreadIdentityMarks: View {
  let identity: ThreadIdentity
  var body: some View {
    // The model rides on the provider as a small badge, so the pair fits a
    // single-line row instead of stacking past it into the next one.
    ProviderMark(identity.providerBrand, size: 22)
      .overlay(alignment: .bottomTrailing) {
        if identity.modelBrand != nil, identity.modelBrand != identity.providerBrand {
          ProviderMark(identity.modelBrand, size: 11)
            .padding(2)
            .background(Color.weave.canvas, in: Circle())
            .overlay(Circle().strokeBorder(Color.weave.line, lineWidth: WeaveSize.hairline))
            .offset(x: 5, y: 5)
        }
      }
      .frame(width: 28, height: 28)
    .accessibilityHidden(true)
  }
}
