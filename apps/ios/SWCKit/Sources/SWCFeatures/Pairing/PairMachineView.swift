import Combine
import SwiftUI
import SWCSync
import Weave

/// Pairs a machine from a pasted link or a scanned QR code.
struct PairMachineView: View {
  /// Set for "Pair again": the link must belong to this machine.
  var expectedMachineId: String?

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.dismiss) private var dismiss
  @Environment(\.sampleData) private var sampleData

  @State private var link = ""
  @State private var connecting = false
  @State private var error: String?
  @State private var scanning = false
  @State private var canPaste = WeaveClipboard.hasText

  private var trimmed: String { link.trimmingCharacters(in: .whitespacesAndNewlines) }

  private var instructions: String {
    let steps = "open SpecWithCode, go to Settings > Connections and choose Create link under Authorized clients. Then scan the code or copy the link."
    if let id = expectedMachineId, let machine = model.machine(id) {
      return "On \(machine.label), \(steps)"
    }
    return "On your computer, \(steps)"
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
          Text(instructions)
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, WeaveSpacing.s4)

        if sampleData.isActive {
          Banner("Exit sample data to pair your own machine.", title: "This is sample data", kind: .info, actionTitle: "Exit sample data") {
            sampleData.exit()
          }
        }

        if QRScanner.isAvailable {
          WeaveButton("Scan QR code", systemImage: "qrcode.viewfinder", kind: .secondary, fullWidth: true) {
            scanning = true
          }
          .disabled(connecting)
        }

        WeaveTextField("https://…#token=…", text: $link, label: "Pairing link", onSubmit: connect) {
          EmptyView()
        } trailing: {
          fieldAccessory
        }
        .linkInput()
        .disabled(connecting)

        if let error {
          Banner(error, title: "Couldn't pair", kind: .fail)
        }

        WeaveButton(connecting ? "Connecting" : "Connect", kind: .primary, fullWidth: true, isLoading: connecting, action: connect)
          .disabled(trimmed.isEmpty || sampleData.isActive)
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.top, WeaveSpacing.s4)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .scrollDismissesKeyboard(.interactively)
    .screenChrome {
      ScreenHeader {
        BackButton()
      } center: {
        HeaderTitle(title: expectedMachineId == nil ? "Pair a machine" : "Pair again")
      } trailing: {
        EmptyView()
      }
    }
    .onReceive(clipboardChanges) { _ in canPaste = WeaveClipboard.hasText }
    .onAppear {
      canPaste = WeaveClipboard.hasText
      if let prefill = router.pairPrefill {
        link = prefill
        router.pairPrefill = nil
      }
    }
    .onChange(of: router.pairPrefill) { _, prefill in
      guard let prefill else { return }
      link = prefill
      router.pairPrefill = nil
    }
    .sheet(isPresented: $scanning) {
      QRScannerSheet { code in
        scanning = false
        link = code
        connect()
      }
      .weaveTheme(appearance: (router.appearanceOverride ?? model.appearance).rawValue)
    }
  }

  /// Clear while there is a link; otherwise paste, shown only when the
  /// clipboard holds text so the button is never a dead control.
  @ViewBuilder private var fieldAccessory: some View {
    if !link.isEmpty {
      Button {
        link = ""
        error = nil
      } label: {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 18))
          .foregroundStyle(Color.weave.control)
          .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Clear link")
    } else if canPaste {
      PasteButton(payloadType: String.self) { values in
        Task { @MainActor in
          if let value = values.first?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
            link = value
            error = nil
          }
        }
      }
      .labelStyle(.titleOnly)
      .buttonBorderShape(.capsule)
      .tint(Color.weave.iris)
      // The system draws a white label, so both themes use the deeper light
      // iris to keep it readable.
      .environment(\.colorScheme, .light)
    }
  }

  private var clipboardChanges: some Publisher<Notification, Never> {
    Publishers.MergeMany(WeaveClipboard.changeNotifications.map { NotificationCenter.default.publisher(for: $0) })
  }

  private func connect() {
    let value = trimmed
    guard !value.isEmpty, !connecting else { return }
    connecting = true
    error = nil
    Task {
      do {
        let machine = try await model.engine.pair(link: value, expectedEnvironmentId: expectedMachineId)
        router.toast = WeaveToastMessage("Paired with \(machine.label)", kind: .pass)
        dismiss()
      } catch {
        self.error = error.localizedDescription
      }
      connecting = false
    }
  }
}

/// Full-height camera view that reads one pairing QR code.
private struct QRScannerSheet: View {
  let onCode: (String) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    ZStack(alignment: .bottom) {
      QRScanner(onCode: onCode)
        .ignoresSafeArea()
        .accessibilityLabel("Camera")
      Text("Point the camera at the code in SpecWithCode on your computer.")
        .weaveFont(.callout)
        .foregroundStyle(Color.weave.ink)
        .multilineTextAlignment(.center)
        .padding(.horizontal, WeaveSpacing.s4)
        .padding(.vertical, WeaveSpacing.s3)
        .weaveGlass(in: RoundedRectangle(cornerRadius: WeaveRadius.lg, style: .continuous))
        .padding(.horizontal, WeaveSpacing.gutter)
        .padding(.bottom, WeaveSpacing.s6)
    }
    .overlay(alignment: .topLeading) {
      WeaveIconButton("xmark", label: "Close") { dismiss() }
        .padding(WeaveSpacing.gutter)
    }
  }
}
