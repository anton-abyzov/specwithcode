import SwiftUI
import SWCSync
import Weave

/// "Your phones" in Settings: the phones on the signed-in Connect account,
/// each removable. A removed phone signs out and stays out until it signs in
/// again.
struct ConnectPhonesCard: View {
  let state: ConnectState
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var phones: [ConnectPhone]?
  @State private var loadError: String?
  @State private var pendingRemoval: ConnectPhone?
  @State private var removing: String?

  var body: some View {
    GroupedCard(label: "Your phones", footer: loadError ?? Self.footer) {
      if let phones {
        if phones.isEmpty {
          WeaveRow("No phones on this account yet", symbol: "iphone")
        }
        ForEach(phones) { phone in
          WeaveRow(phone.title, subtitle: phone.settingsSubtitle(), stacksTrailing: true, action: removing == nil ? { pendingRemoval = phone } : nil) {
            WeaveRowSymbol("iphone")
          } trailing: {
            if removing == phone.id {
              ProgressView().controlSize(.small)
            } else {
              WeaveRowTrailingText(phone.isThisPhone ? "This iPhone" : nil)
            }
          }
          .accessibilityHint("Removes this phone from your account")
        }
      } else if loadError == nil {
        WeaveRow("Loading phones") {
          WeaveRowSymbol("iphone")
        } trailing: {
          ProgressView().controlSize(.small)
        }
      } else {
        WeaveRow("Try again", symbol: "arrow.clockwise") { Task { await load() } }
      }
    }
    .task(id: state.user?.id) { await load() }
    .alert(
      pendingRemoval.map { Self.confirmTitle($0) } ?? "",
      isPresented: Binding(get: { pendingRemoval != nil }, set: { if !$0 { pendingRemoval = nil } }),
      presenting: pendingRemoval
    ) { phone in
      Button(phone.isThisPhone ? "Remove and sign out" : "Remove", role: .destructive) { remove(phone) }
      Button("Cancel", role: .cancel) {}
    } message: { phone in
      Text(Self.confirmMessage(phone))
    }
  }

  static let footer = "A removed phone signs out and can't reach your Macs until it signs in again."

  /// `isThisPhone` is set when the relay marks the row as the caller's
  /// session or its device id is this phone's own, so removing it here is
  /// always announced as signing this iPhone out.
  static func confirmTitle(_ phone: ConnectPhone) -> String {
    phone.isThisPhone ? "Remove this iPhone?" : "Remove \(phone.title)?"
  }

  static func confirmMessage(_ phone: ConnectPhone) -> String {
    phone.isThisPhone
      ? "This signs this iPhone out of SpecWithCode Connect. It forgets the Macs it reached through your account; Macs you paired with a link or QR code stay."
      : "\(phone.title) stops getting notifications and signs out. It can't reach your Macs until it signs in again."
  }

  private func load() async {
    guard state.isSignedIn else { return }
    loadError = nil
    do {
      phones = try await model.engine.connectPhones()
    } catch is CancellationError {
    } catch {
      if phones == nil { loadError = error.localizedDescription }
    }
  }

  private func remove(_ phone: ConnectPhone) {
    removing = phone.id
    Task {
      do {
        try await model.engine.connectRemovePhone(phone.id)
        phones?.removeAll { $0.id == phone.id }
        // This phone signs out with it; the card goes away.
        if model.connect?.isSignedIn == true { await load() }
      } catch {
        router.showError(error)
      }
      removing = nil
    }
  }
}

extension ConnectPhone {
  /// The model; builds before November 2026 could only report "iPhone" for newer phones.
  private var knownModel: String? { model == "iPhone" ? nil : model }

  /// The chosen name, else the model: a phone's own name usually reads just "iPhone".
  var title: String {
    guard label == "iPhone" || label == model else { return label }
    return knownModel ?? "iPhone"
  }

  /// "iPhone 16 Pro · iOS 27 · App 0.1.4 · Seen 2 hr ago". This phone is in use, so no time.
  func settingsSubtitle(now: Date = Date()) -> String? {
    var parts: [String] = []
    if let knownModel {
      if knownModel != title { parts.append(knownModel) }
    } else if label == "iPhone" {
      parts.append("Model shows after the app updates")
    }
    if let iosMajorVersion { parts.append("iOS \(iosMajorVersion)") }
    if let appVersion { parts.append(isDevBuild ? "App \(appVersion) (dev build)" : "App \(appVersion)") }
    if !isThisPhone, let lastSeen {
      let seen = MachineSummary.relative(lastSeen, now: now)
      parts.append(seen == "just now" ? "Seen just now" : "Seen \(seen)")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }
}
