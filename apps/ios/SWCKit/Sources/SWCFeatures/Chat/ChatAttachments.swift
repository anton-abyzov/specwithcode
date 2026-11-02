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
          Label(attachment.name, systemImage: "doc")
            .font(.weave(.callout))
            .foregroundStyle(Color.weave.muted)
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

  var body: some View {
    content
      .frame(width: 220, height: 165)
      .background(Color.weave.sunken)
      .clipShape(RoundedRectangle(cornerRadius: WeaveRadius.bubble, style: .continuous))
      .accessibilityElement()
      .accessibilityLabel("Photo, \(attachment.name)")
      .accessibilityIdentifier("message.attachment")
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
  func attachmentPickers(isChoosing: Binding<Bool>, onPicked: @escaping (_ photos: [Data], _ failed: Int) -> Void) -> some View {
    modifier(AttachmentPickers(isChoosing: isChoosing, onPicked: onPicked))
  }
}

private struct AttachmentPickers: ViewModifier {
  @Binding var isChoosing: Bool
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
        Task {
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
