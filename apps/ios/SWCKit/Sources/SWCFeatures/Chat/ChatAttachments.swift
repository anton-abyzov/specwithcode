import PhotosUI
import SwiftUI
import SWCSync
import Weave
#if canImport(UIKit)
import UIKit
#endif

/// Pictures on a user message: the local preview while sending, then the machine's copy.
struct MessageAttachments: View {
  let attachments: [TranscriptAttachment]
  let environmentId: String

  var body: some View {
    VStack(alignment: .trailing, spacing: WeaveSpacing.s2) {
      ForEach(attachments) { attachment in
        if attachment.isImage {
          MessageImage(attachment: attachment, environmentId: environmentId)
        } else {
          MessageFile(attachment: attachment, environmentId: environmentId)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .padding(.leading, 56)
  }
}

private struct MessageImage: View {
  let attachment: TranscriptAttachment
  let environmentId: String

  @Environment(AppModel.self) private var model
  @State private var url: URL?
  @State private var failed = false
  @State private var loaded = false
  @State private var enlarged = false

  /// Only a picture that is on screen can open; a failed or loading one stays put.
  private var canEnlarge: Bool { attachment.preview != nil || loaded }

  var body: some View {
    Button { enlarged = true } label: {
      content
        .frame(width: 220, height: 165)
        .background(Color.weave.sunken)
        .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.bubble, style: .continuous))
    }
      .buttonStyle(PressableStyle())
      .disabled(!canEnlarge)
      .accessibilityLabel("Photo, \(attachment.name)")
      .accessibilityHint(canEnlarge ? "Opens the photo" : "")
      .accessibilityIdentifier("message.attachment")
      .imageViewerCover(isPresented: $enlarged) {
        AttachmentImageViewer(name: attachment.name, preview: attachment.preview, url: url)
      }
      // Keyed on the connection too, so a picture that failed loads after a reconnect.
      .task(id: "\(attachment.id)-\(model.machine(environmentId)?.status.isOnline == true)") {
        guard attachment.preview == nil, !loaded else { return }
        url = nil
        failed = false
        do {
          url = try await model.engine.attachmentURL(attachment, on: environmentId)
          failed = url == nil
        } catch { failed = true }
      }
  }

  @ViewBuilder private var content: some View {
    if let preview = attachment.preview, let image = PlatformImage(preview) {
      image.resizable().scaledToFill()
    } else if failed {
      Image(systemName: "photo").foregroundStyle(Color.weave.muted)
    } else {
      AsyncImage(url: url) { phase in
        switch phase {
        case let .success(image): image.resizable().scaledToFill().onAppear { loaded = true }
        case .failure: Image(systemName: "photo").foregroundStyle(Color.weave.muted)
        case .empty: ProgressView()
        @unknown default: ProgressView()
        }
      }
    }
  }
}

/// A non-image attachment on a user message. The machine serves it, and the system opens it.
private struct MessageFile: View {
  let attachment: TranscriptAttachment
  let environmentId: String

  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @Environment(\.openURL) private var openURL
  @State private var opening = false

  private struct Unavailable: LocalizedError {
    var errorDescription: String? { "This file is on a machine that isn't connected." }
  }

  var body: some View {
    Button(action: open) {
      Label(attachment.name, systemImage: "doc")
        .font(.weave(.callout))
        .foregroundStyle(Color.weave.muted)
        .frame(minHeight: WeaveSize.minTap)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .disabled(opening)
    .accessibilityHint("Opens the file")
    .accessibilityIdentifier("message.file")
  }

  private func open() {
    opening = true
    Task {
      defer { opening = false }
      do {
        guard let url = try await model.engine.attachmentURL(attachment, on: environmentId) else { throw Unavailable() }
        openURL(url)
      } catch { router.showError(error) }
    }
  }
}

/// How far a picture opened from a message can zoom.
enum ImageZoom {
  static let range: ClosedRange<CGFloat> = 1...5

  static func clamped(_ scale: CGFloat) -> CGFloat {
    min(max(scale, range.lowerBound), range.upperBound)
  }

  /// A double tap zooms in, and zooms back out from any zoomed state.
  static func afterDoubleTap(from scale: CGFloat) -> CGFloat {
    scale > range.lowerBound ? range.lowerBound : 2.5
  }
}

/// A message's picture on its own: pinch or double tap to zoom, drag to move while zoomed.
private struct AttachmentImageViewer: View {
  let name: String
  let preview: Data?
  let url: URL?

  @Environment(\.dismiss) private var dismiss
  @State private var scale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @GestureState private var pinch: CGFloat = 1
  @GestureState private var pan: CGSize = .zero

  var body: some View {
    ZStack(alignment: .topTrailing) {
      Color.black.ignoresSafeArea()
      picture
        .scaleEffect(ImageZoom.clamped(scale * pinch))
        .offset(x: offset.width + pan.width, y: offset.height + pan.height)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .accessibilityLabel("Photo, \(name)")
        .accessibilityIdentifier("message.attachment.viewer")
        .gesture(magnify)
        .simultaneousGesture(move)
        .onTapGesture(count: 2) {
          withAnimation(.snappy) {
            scale = ImageZoom.afterDoubleTap(from: scale)
            offset = .zero
          }
        }
      Button { dismiss() } label: {
        Image(systemName: "xmark")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
          .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel("Close")
      .accessibilityIdentifier("message.attachment.close")
      .padding(WeaveSpacing.s2)
    }
  }

  @ViewBuilder private var picture: some View {
    if let preview, let image = PlatformImage(preview) {
      image.resizable().scaledToFit()
    } else {
      AsyncImage(url: url) { phase in
        switch phase {
        case let .success(image): image.resizable().scaledToFit()
        case .failure: Image(systemName: "photo").foregroundStyle(.white)
        case .empty: ProgressView().tint(.white)
        @unknown default: ProgressView().tint(.white)
        }
      }
    }
  }

  private var magnify: some Gesture {
    MagnifyGesture()
      .updating($pinch) { value, state, _ in state = value.magnification }
      .onEnded { value in
        scale = ImageZoom.clamped(scale * value.magnification)
        if scale == ImageZoom.range.lowerBound { offset = .zero }
      }
  }

  /// Off until zoomed in, so a resting picture has nothing to drag.
  private var move: some Gesture {
    DragGesture(minimumDistance: scale > ImageZoom.range.lowerBound ? 0 : .infinity)
      .updating($pan) { value, state, _ in state = value.translation }
      .onEnded { value in
        offset.width += value.translation.width
        offset.height += value.translation.height
      }
  }
}

private extension View {
  /// Full screen on iOS. The Mac build this package also compiles for has only sheets.
  @ViewBuilder func imageViewerCover<Content: View>(isPresented: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) -> some View {
    #if os(iOS)
    fullScreenCover(isPresented: isPresented, content: content)
    #else
    sheet(isPresented: isPresented, content: content)
    #endif
  }
}

/// The pictures waiting to be sent, above the composer.
struct ComposerAttachmentStrip: View {
  let images: [OutgoingImage]
  let isLoading: Bool
  let onRemove: (OutgoingImage) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: WeaveSpacing.s2) {
        ForEach(images) { image in
          ZStack(alignment: .topTrailing) {
            if let picture = PlatformImage(image.preview) {
              picture.resizable().scaledToFill()
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityHidden(true)
            }
            Button { onRemove(image) } label: {
              Image(systemName: "xmark.circle.fill")
                .font(.system(size: 20))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.65))
                .frame(width: WeaveSize.minTap, height: WeaveSize.minTap, alignment: .topTrailing)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove photo")
          }
          .frame(width: 64, height: 64)
        }
        if isLoading {
          ProgressView()
            .frame(width: 64, height: 64)
            .accessibilityLabel("Preparing photo")
        }
      }
      .padding(.horizontal, WeaveSpacing.s2)
    }
    .accessibilityIdentifier("composer.attachments")
  }
}

/// A `SwiftUI.Image` from encoded bytes on either platform this package builds for.
private func PlatformImage(_ data: Data) -> Image? {
  #if canImport(UIKit)
  UIImage(data: data).map(Image.init(uiImage:))
  #else
  NSImage(data: data).map(Image.init(nsImage:))
  #endif
}

extension View {
  /// The Attach button's choices: the system Photos picker, which runs out of
  /// process and needs no photo library permission, and the camera where there is one.
  func attachmentPickers(isChoosing: Binding<Bool>, onLoading: @escaping (Bool) -> Void, onPicked: @escaping (_ photos: [Data], _ failed: Int) -> Void) -> some View {
    modifier(AttachmentPickers(isChoosing: isChoosing, onLoading: onLoading, onPicked: onPicked))
  }
}

private struct AttachmentPickers: ViewModifier {
  @Binding var isChoosing: Bool
  let onLoading: (Bool) -> Void
  let onPicked: ([Data], Int) -> Void

  @State private var showingPhotos = false
  @State private var showingCamera = false
  @State private var selection: [PhotosPickerItem] = []

  private static let maximumAtOnce = 6

  func body(content: Content) -> some View {
    content
      .confirmationDialog("Attach", isPresented: showingChoice, titleVisibility: .hidden) {
        Button("Photo Library") { showingPhotos = true }
        Button("Take Photo") { showingCamera = true }
        Button("Cancel", role: .cancel) {}
      }
      .onChange(of: isChoosing) { _, choosing in
        guard choosing else { return }
        // Without a camera the only choice is the library, so skip the question.
        if !Self.hasCamera { isChoosing = false; showingPhotos = true }
      }
      .photosPicker(isPresented: $showingPhotos, selection: $selection, maxSelectionCount: Self.maximumAtOnce, matching: .images, preferredItemEncoding: .current)
      .onChange(of: selection) { _, items in
        guard !items.isEmpty else { return }
        selection = []
        onLoading(true)
        Task {
          defer { onLoading(false) }
          var loaded: [Data] = []
          for item in items {
            // A photo kept only in iCloud can fail to download here.
            if let data = try? await item.loadTransferable(type: Data.self) { loaded.append(data) }
          }
          onPicked(loaded, items.count - loaded.count)
        }
      }
      #if canImport(UIKit)
      .fullScreenCover(isPresented: $showingCamera) {
        CameraPicker { data in onPicked([data], 0) }
          .ignoresSafeArea()
      }
      #endif
  }

  private var showingChoice: Binding<Bool> {
    Binding(get: { isChoosing && Self.hasCamera }, set: { isChoosing = $0 })
  }

  private static var hasCamera: Bool {
    #if canImport(UIKit)
    UIImagePickerController.isSourceTypeAvailable(.camera)
    #else
    false
    #endif
  }
}

#if canImport(UIKit)
private struct CameraPicker: UIViewControllerRepresentable {
  let onCapture: (Data) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) { parent.onCapture(data) }
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
  }
}
#endif
