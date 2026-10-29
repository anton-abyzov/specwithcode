import SwiftUI

#if os(iOS)
import UIKit

/// The drawer owns its safe-area padding, including a keyboard restored by
/// NavigationStack. Measure in its window rather than relying on safe-area
/// propagation through the drawer's clipped, full-screen content.
struct KeyboardInsetReader: UIViewRepresentable {
  let onChange: (CGFloat) -> Void

  func makeUIView(context: Context) -> KeyboardFrameView {
    let view = KeyboardFrameView()
    view.onChange = onChange
    return view
  }

  func updateUIView(_ view: KeyboardFrameView, context: Context) {
    view.onChange = onChange
  }
}

final class KeyboardFrameView: UIView {
  var onChange: ((CGFloat) -> Void)?
  private var keyboardFrame: CGRect?
  private var lastInset: CGFloat = 0

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardHidden), name: UIResponder.keyboardWillHideNotification, object: nil)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit { NotificationCenter.default.removeObserver(self) }

  override func layoutSubviews() {
    super.layoutSubviews()
    updateInset()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    updateInset()
  }

  @objc private func keyboardChanged(_ notification: Notification) {
    keyboardFrame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect
    updateInset()
  }

  @objc private func keyboardHidden(_ notification: Notification) {
    keyboardFrame = nil
    updateInset()
  }

  private func updateInset() {
    guard let window, bounds.height > 0 else { return }
    var inset: CGFloat = 0
    if let keyboardFrame {
      let local = convert(keyboardFrame, from: window.screen.coordinateSpace)
      // A floating keyboard must not collapse the whole scene.
      if local.minX <= bounds.minX + 1, local.maxX >= bounds.maxX - 1,
         local.maxY >= bounds.maxY - 1 {
        inset = min(bounds.height, max(0, bounds.maxY - local.minY))
      }
    }
    guard abs(inset - lastInset) > 0.5 else { return }
    lastInset = inset
    // layoutSubviews may be called inside a SwiftUI update.
    DispatchQueue.main.async { [weak self] in self?.onChange?(inset) }
  }
}
#else
struct KeyboardInsetReader: View {
  let onChange: (CGFloat) -> Void
  var body: some View { Color.clear }
}
#endif
