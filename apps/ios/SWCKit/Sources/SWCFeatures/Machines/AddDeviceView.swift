import SwiftUI
import SWCSync
import Weave

/// "Add a device or machine", the same screen as the desktop app's dialog:
/// one choice, a phone or a computer, and for each the link that gets the
/// app and the account to sign in with. Nothing to do on this phone; the new
/// device shows up by itself. Pairing with a link or QR code stays as the
/// way in without SpecWithCode Connect.
struct AddDeviceView: View {
  enum Kind: Hashable { case phone, computer }

  @Environment(AppModel.self) private var model
  @Environment(StackNavigator.self) private var nav
  @State private var kind: Kind = .computer

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        SegmentedPill(selection: $kind, options: [(value: Kind.computer, label: "A computer"), (value: Kind.phone, label: "A phone")])
        if let account = Self.account(model.connect) {
          GroupedCard(label: Self.label(kind), footer: Self.footer(kind)) {
            ForEach(Array(Self.steps(kind, account: account).enumerated()), id: \.offset) { index, step in
              WeaveRow(step, symbol: "\(index + 1).circle")
            }
            ShareLink(item: Self.url(kind)) {
              WeaveRow("Send the link", subtitle: Self.url(kind).absoluteString, symbol: "square.and.arrow.up")
            }
            .accessibilityIdentifier("add-device.share")
          }
        }
        GroupedCard(footer: Self.fallbackFooter(signedIn: Self.account(model.connect) != nil)) {
          WeaveRow("Pair with a link or QR code", symbol: "qrcode", showsChevron: true) { nav.push(.pair) }
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .screenChrome {
      ScreenHeader {
        BackButton()
      } center: {
        HeaderTitle(title: "Add a device or machine")
      } trailing: {
        EmptyView()
      }
    }
  }

  /// The SpecWithCode Connect account this phone is signed in to, if any.
  static func account(_ connect: ConnectState?) -> String? {
    guard let connect, connect.isSignedIn, let user = connect.user else { return nil }
    return user.email ?? user.displayName
  }

  static func url(_ kind: Kind) -> URL {
    switch kind {
    case .phone: URL(string: "https://specwithcode.com/get")!
    case .computer: URL(string: "https://specwithcode.com/download")!
    }
  }

  static func label(_ kind: Kind) -> String {
    kind == .phone ? "On the new phone" : "On the new computer"
  }

  /// The same steps as the desktop app's dialog, in the same words.
  static func steps(_ kind: Kind, account: String) -> [String] {
    switch kind {
    case .phone:
      ["Open specwithcode.com/get. It opens the App Store on an iPhone and Google Play on Android.",
       "Sign in as \(account).",
       "Your machines show up on the phone by themselves."]
    case .computer:
      ["Open specwithcode.com/download and install SpecWithCode.",
       "Sign in as \(account).",
       "Pick your main machine and press Allow there. It shows up here by itself."]
    }
  }

  static func footer(_ kind: Kind) -> String {
    kind == .phone ? "iPhone or Android." : "Mac, Windows or Linux."
  }

  static func fallbackFooter(signedIn: Bool) -> String {
    signedIn
      ? "Cannot use Connect? Pair over your own network with the code from Settings > Machines on the computer."
      : "Sign in to SpecWithCode Connect in Settings to add devices with your account, or pair a machine with the code from Settings > Machines on the computer."
  }
}
