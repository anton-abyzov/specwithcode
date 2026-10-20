import SwiftUI
import SWCSync
import Weave

/// One button per sign-in method, Sign in with Apple first.
struct ConnectSignInButtons: View {
  let state: ConnectState
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var pending: ConnectSignInMethod?

  var body: some View {
    VStack(spacing: WeaveSpacing.s2) {
      ForEach(state.methods) { method in
        WeaveButton(method.title, systemImage: Self.symbol(method), kind: method == .apple ? .primary : .secondary, fullWidth: true, isLoading: pending == method) {
          signIn(method)
        }
        .disabled(pending != nil)
      }
    }
  }

  private func signIn(_ method: ConnectSignInMethod) {
    pending = method
    Task {
      do {
        try await model.engine.connectSignIn(with: method)
      } catch is CancellationError {
      } catch {
        router.showError(error)
      }
      pending = nil
    }
  }

  static func symbol(_ method: ConnectSignInMethod) -> String? {
    switch method {
    case .apple: "apple.logo"
    case .google, .github: "person.crop.circle"
    }
  }
}

/// First run with SpecWithCode Connect: sign in, or wait for a computer to
/// appear on the account.
struct ConnectWelcomeContent: View {
  let state: ConnectState
  @Environment(AppModel.self) private var model

  static let signedInSteps = [
    "Open SpecWithCode on your Mac.",
    "In Settings > Connections, turn on SpecWithCode Connect and sign in with the same account.",
    "Your Mac appears here. Tap it to start.",
  ]

  var body: some View {
    VStack(spacing: WeaveSpacing.s4) {
      if let user = state.user {
        Text("Signed in as \(user.displayName ?? user.email ?? "you"). No computers on this account yet.")
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .multilineTextAlignment(.center)
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(Self.signedInSteps.enumerated()), id: \.offset) { index, step in
            if index > 0 { WeaveDivider(leadingInset: 60) }
            StepRow(number: index + 1, text: step)
          }
        }
        .weavePanel(in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
        WeaveButton("Check again", systemImage: "arrow.clockwise", kind: .secondary, isLoading: state.isBusy) {
          Task { await model.engine.connectRefresh() }
        }
      } else {
        Text("Sign in with the account you use in SpecWithCode on your Mac. Your Macs appear here, wherever you are.")
          .weaveFont(.callout)
          .foregroundStyle(Color.weave.muted)
          .multilineTextAlignment(.center)
        ConnectSignInButtons(state: state)
      }
      if let error = state.lastError {
        Text(error)
          .weaveFont(.caption)
          .foregroundStyle(Color.weave.muted)
          .multilineTextAlignment(.center)
      }
    }
  }
}

/// The account card in Settings.
struct ConnectAccountCard: View {
  let state: ConnectState
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var confirmSignOut = false
  @State private var confirmDelete = false
  @State private var deleting = false

  var body: some View {
    Group {
      if let user = state.user {
        GroupedCard(label: "Account", footer: "Your Macs signed in to this account appear on this phone.", separatorInset: 56) {
          WeaveRow(user.displayName ?? user.email ?? "Signed in", subtitle: user.displayName == nil ? nil : user.email, symbol: "person.crop.circle")
          WeaveRow("Sign out", symbol: "rectangle.portrait.and.arrow.right") { confirmSignOut = true }
          WeaveRow("Delete account", symbol: "trash", isDestructive: true) { confirmDelete = true }
        }
      } else {
        VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
          FieldLabel("Account")
          ConnectSignInButtons(state: state)
          Text("Sign in with the account you use in SpecWithCode on your Mac to reach it from anywhere.")
            .font(.weave(.caption))
            .foregroundStyle(Color.weave.muted)
            .padding(.horizontal, WeaveSpacing.s4)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .confirmationDialog("Sign out?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) { Task { await model.engine.connectSignOut() } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This phone forgets the Macs it reached through your account. Macs you paired with a link or QR code stay.")
    }
    .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
      Button("Delete account", role: .destructive) { deleteAccount() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This permanently deletes your SpecWithCode account, unlinks your Macs from it and signs you out on every device. SpecWithCode keeps running on your Macs, and Macs you paired with a link or QR code stay. This can't be undone.")
    }
  }

  private func deleteAccount() {
    deleting = true
    Task {
      do {
        try await model.engine.connectDeleteAccount()
      } catch {
        router.showError(error)
      }
      deleting = false
    }
  }
}

struct StepRow: View {
  let number: Int
  let text: String

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: WeaveSpacing.s4) {
      Text("\(number)")
        .font(.weave(.callout, weight: .semibold))
        .foregroundStyle(Color.weave.irisStrong)
        .frame(width: 28, height: 28)
        .background(Color.weave.irisTint, in: Circle())
        .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
      Text(text)
        .weaveFont(.body)
        .foregroundStyle(Color.weave.ink)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, WeaveSpacing.s4)
    .padding(.vertical, WeaveSpacing.s3 + 2)
    .frame(minHeight: 56)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Step \(number): \(text)")
  }
}

extension MachineSummary {
  /// "Offline · checked 5 min ago" for a Mac reached through Connect.
  var connectStatusLabel: String? {
    if needsSignIn { return "Sign in again" }
    guard viaConnect, status == .offline, !isStale else { return nil }
    guard let checkedAt else { return "Offline" }
    return "Offline · checked \(Self.relative(checkedAt))"
  }

  static func relative(_ date: Date, now: Date = Date()) -> String {
    if now.timeIntervalSince(date) < 60 { return "just now" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: now)
  }
}
