import CoreGraphics
import Foundation
import ImageIO
import SWCWire
import UniformTypeIdentifiers

/// An attachment shown on a user message.
public struct TranscriptAttachment: Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let mimeType: String
  public let isImage: Bool
  /// A small local picture while the message is on its way; the machine serves the rest.
  public let preview: Data?

  public init(id: String, name: String, mimeType: String, isImage: Bool, preview: Data? = nil) {
    self.id = id
    self.name = name
    self.mimeType = mimeType
    self.isImage = isImage
    self.preview = preview
  }

  init(_ attachment: ChatAttachment) {
    self.init(id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, isImage: attachment.isImage)
  }
}

/// A picture ready to send: encoded here, so HEIC and other camera formats never
/// reach a provider, and its location and other metadata never leave the phone.
public struct OutgoingImage: Hashable, Sendable, Identifiable {
  public let id: String
  public let name: String
  public let mimeType = "image/jpeg"
  public let data: Data
  public let preview: Data

  var transcriptAttachment: TranscriptAttachment {
    TranscriptAttachment(id: id, name: name, mimeType: mimeType, isImage: true, preview: preview)
  }
}

public struct PhotoAttachmentError: LocalizedError, Equatable {
  public let errorDescription: String?
}

public enum PhotoAttachmentEncoder {
  /// `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` and `..._TOTAL_IMAGE_BYTES`.
  public static let maximumBytes = 10 * 1024 * 1024
  public static let maximumTotalBytes = 22 * 1024 * 1024
  static let attempts: [(pixels: Int, quality: Double)] = [(2048, 0.82), (2048, 0.6), (1600, 0.6), (1024, 0.5)]

  /// - Parameter data: The picture in any format the system decodes, HEIC included.
  public static func encode(_ data: Data, index: Int = 1, now: Date = Date()) throws -> OutgoingImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetCount(source) > 0 else {
      throw PhotoAttachmentError(errorDescription: "This photo could not be read. Try another one.")
    }
    for attempt in attempts {
      if let jpeg = jpeg(source, maxPixels: attempt.pixels, quality: attempt.quality), jpeg.count <= maximumBytes {
        let preview = Self.jpeg(source, maxPixels: 320, quality: 0.7) ?? jpeg
        let stamp = Int(now.timeIntervalSince1970)
        return OutgoingImage(id: UUID().uuidString, name: "photo-\(stamp)-\(index).jpg", data: jpeg, preview: preview)
      }
    }
    throw PhotoAttachmentError(errorDescription: "This photo is too large to send. Try another one.")
  }

  /// Decodes at size with the photo's orientation applied, then draws on white in
  /// sRGB: transparency, wide color and HDR all become a plain JPEG with no metadata.
  private static func jpeg(_ source: CGImageSource, maxPixels: Int, quality: Double) -> Data? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixels,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
          let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(bounds)
    context.draw(image, in: bounds)
    guard let flat = context.makeImage() else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, flat, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    return CGImageDestinationFinalize(destination) ? output as Data : nil
  }
}

struct AttachmentUploadTicket: Decodable, Sendable {
  let attachmentId: String
  let relativeUrl: String
}

struct AssetURLResult: Decodable, Sendable {
  let relativeUrl: String
}
