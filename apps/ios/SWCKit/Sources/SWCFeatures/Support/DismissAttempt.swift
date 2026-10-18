import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

extension View {
  /// Calls `action` when someone swipes down a sheet that
  /// `interactiveDismissDisabled` keeps open, so the sheet can say why
  /// instead of silently bouncing back. SwiftUI has no hook for this.
  func onSheetDismissAttempt(_ action: @escaping () -> Void) -> some View {
    #if canImport(UIKit)
    background(DismissAttemptObserver(onAttempt: action).frame(width: 0, height: 0).accessibilityHidden(true))
    #else
    self
    #endif
  }
}

#if canImport(UIKit)
/// Finds the presentation controller of the sheet it sits in and wraps its
/// delegate. Every other delegate call goes on to SwiftUI's own delegate,
/// which keeps the sheet binding in sync.
private struct DismissAttemptObserver: UIViewControllerRepresentable {
  let onAttempt: () -> Void

  func makeUIViewController(context: Context) -> ObserverController {
    ObserverController(onAttempt: onAttempt)
  }

  func updateUIViewController(_ controller: ObserverController, context: Context) {
    controller.proxy.onAttempt = onAttempt
  }

  final class ObserverController: UIViewController {
    let proxy: DismissAttemptProxy

    init(onAttempt: @escaping () -> Void) {
      proxy = DismissAttemptProxy(onAttempt: onAttempt)
      super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func loadView() {
      view = UIView(frame: .zero)
      view.isUserInteractionEnabled = false
    }

    override func viewDidAppear(_ animated: Bool) {
      super.viewDidAppear(animated)
      install()
    }

    /// SwiftUI sets its delegate when it presents the sheet, so this waits
    /// until the sheet is on screen. Installing twice is harmless.
    private func install() {
      guard let presentation = sheetPresentation, presentation.delegate !== proxy else { return }
      proxy.original = presentation.delegate
      presentation.delegate = proxy
    }

    /// The presentation controller of the presented controller this one sits
    /// in: the top of its parent chain, when that is presented.
    private var sheetPresentation: UIPresentationController? {
      var top: UIViewController = self
      while let parent = top.parent { top = parent }
      guard top !== self, top.presentingViewController != nil else { return nil }
      return top.presentationController
    }
  }
}

/// Forwards every presentation delegate call to the original delegate and
/// reports dismiss attempts on the way through.
private final class DismissAttemptProxy: NSObject, UIAdaptivePresentationControllerDelegate {
  /// Read by the Objective-C forwarding overrides, which are nonisolated;
  /// UIKit only calls them on the main thread.
  nonisolated(unsafe) weak var original: (any UIAdaptivePresentationControllerDelegate)?
  var onAttempt: () -> Void

  init(onAttempt: @escaping () -> Void) {
    self.onAttempt = onAttempt
  }

  func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
    onAttempt()
    original?.presentationControllerDidAttemptToDismiss?(presentationController)
  }

  nonisolated override func responds(to aSelector: Selector!) -> Bool {
    super.responds(to: aSelector) || (original?.responds(to: aSelector) ?? false)
  }

  nonisolated override func forwardingTarget(for aSelector: Selector!) -> Any? {
    if let original, original.responds(to: aSelector) { return original }
    return super.forwardingTarget(for: aSelector)
  }
}
#endif
