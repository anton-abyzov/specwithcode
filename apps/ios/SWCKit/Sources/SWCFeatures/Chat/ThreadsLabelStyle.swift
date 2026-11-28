import SwiftUI
import Weave

/// The header's Threads button: icon and title, or only the icon when the
/// header is short of room. VoiceOver reads "Threads" either way.
struct ThreadsLabelStyle: LabelStyle {
  let showsTitle: Bool

  func makeBody(configuration: Configuration) -> some View {
    if showsTitle {
      Label(configuration)
    } else {
      configuration.icon
        .frame(minWidth: WeaveSize.minTap)
        .accessibilityShowsLargeContentViewer { Label(configuration) }
    }
  }
}
