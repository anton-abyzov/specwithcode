import SwiftUI

#if os(iOS) && canImport(VisionKit)
import VisionKit

/// Live camera QR reader. Reports the first code it reads, once.
struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  /// The device has a camera that can scan and the person allows it.
  static var isAvailable: Bool {
    DataScannerViewController.isSupported && DataScannerViewController.isAvailable
  }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let controller = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: true,
      isHighlightingEnabled: true
    )
    controller.delegate = context.coordinator
    // Scanning starts once the controller is on screen.
    Task { @MainActor in try? controller.startScanning() }
    return controller
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {
    context.coordinator.onCode = onCode
  }

  static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) {
    controller.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    var onCode: (String) -> Void
    private var delivered = false

    init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

    func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      deliver(addedItems)
    }

    func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
      deliver([item])
    }

    private func deliver(_ items: [RecognizedItem]) {
      guard !delivered else { return }
      for item in items {
        if case let .barcode(barcode) = item, let value = barcode.payloadStringValue, !value.isEmpty {
          delivered = true
          onCode(value)
          return
        }
      }
    }
  }
}
#else
/// Camera scanning is not available on this platform.
struct QRScanner: View {
  let onCode: (String) -> Void

  static var isAvailable: Bool { false }

  var body: some View { Color.black }
}
#endif
