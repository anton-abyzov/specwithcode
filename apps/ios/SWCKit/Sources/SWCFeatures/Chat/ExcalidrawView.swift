import SwiftUI
import Weave

/// The drawable part of an `.excalidraw` file: its live elements. Images,
/// embeds and frames are left out; a scene of only those has nothing to draw.
nonisolated struct ExcalidrawScene: Equatable, Sendable {
  struct Element: Equatable, Sendable {
    enum Kind: String, Sendable {
      case rectangle, ellipse, diamond, line, arrow, freedraw, text
    }

    var kind: Kind
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var angle: Double
    var stroke: String
    var background: String
    var strokeWidth: Double
    var opacity: Double
    var points: [CGPoint]
    var text: String
    var fontSize: Double
    var textAlign: String
    var rounded: Bool
    var startArrow: Bool
    var endArrow: Bool
    var dashed: Bool
  }

  var elements: [Element]
  var background: String?

  /// The box around every element, in scene units.
  var bounds: CGRect {
    elements.reduce(CGRect.null) { box, element in
      var frame = CGRect(x: element.x, y: element.y, width: element.width, height: element.height).standardized
      if !element.points.isEmpty {
        let xs = element.points.map(\.x), ys = element.points.map(\.y)
        frame = CGRect(x: element.x + (xs.min() ?? 0), y: element.y + (ys.min() ?? 0),
                       width: (xs.max() ?? 0) - (xs.min() ?? 0), height: (ys.max() ?? 0) - (ys.min() ?? 0))
      }
      return box.union(frame.insetBy(dx: -element.strokeWidth, dy: -element.strokeWidth))
    }
  }

  /// At most this many elements are drawn, so a huge board cannot stall a frame.
  static let maxElements = 5_000

  static func decode(_ text: String) -> ExcalidrawScene? {
    guard let data = text.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let raw = root["elements"] as? [[String: Any]] else { return nil }
    let elements: [Element] = raw.prefix(maxElements).compactMap { item in
      guard item["isDeleted"] as? Bool != true,
            let type = item["type"] as? String, let kind = Element.Kind(rawValue: type) else { return nil }
      func number(_ key: String, _ fallback: Double = 0) -> Double {
        (item[key] as? NSNumber)?.doubleValue ?? fallback
      }
      let points = (item["points"] as? [[Any]] ?? []).compactMap { pair -> CGPoint? in
        guard pair.count >= 2, let x = (pair[0] as? NSNumber)?.doubleValue, let y = (pair[1] as? NSNumber)?.doubleValue else { return nil }
        return CGPoint(x: x, y: y)
      }
      return Element(
        kind: kind,
        x: number("x"), y: number("y"), width: number("width"), height: number("height"),
        angle: number("angle"),
        stroke: item["strokeColor"] as? String ?? "#1e1e1e",
        background: item["backgroundColor"] as? String ?? "transparent",
        strokeWidth: max(0.5, number("strokeWidth", 1)),
        opacity: min(1, max(0, number("opacity", 100) / 100)),
        points: points,
        text: item["text"] as? String ?? item["originalText"] as? String ?? "",
        fontSize: max(4, number("fontSize", 20)),
        textAlign: item["textAlign"] as? String ?? "left",
        rounded: item["roundness"] is [String: Any],
        startArrow: (item["startArrowhead"] as? String) != nil,
        endArrow: (item["endArrowhead"] as? String) != nil,
        dashed: (item["strokeStyle"] as? String).map { $0 != "solid" } ?? false
      )
    }
    let appState = root["appState"] as? [String: Any]
    return ExcalidrawScene(elements: elements, background: appState?["viewBackgroundColor"] as? String)
  }
}

/// A whiteboard on the phone: fit to the screen, pinch to zoom, drag to pan,
/// double-tap to toggle 2x. Drawn as vectors at every zoom. In dark mode the
/// colors invert the way Excalidraw's own dark theme does.
struct ExcalidrawView: View {
  let scene: ExcalidrawScene

  @Environment(\.colorScheme) private var colorScheme
  @State private var scale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @GestureState private var pinch: CGFloat = 1
  @GestureState private var pan: CGSize = .zero

  static let zoom: ClosedRange<CGFloat> = 1...8

  var body: some View {
    GeometryReader { proxy in
      let zoom = min(Self.zoom.upperBound, max(Self.zoom.lowerBound, scale * pinch))
      Canvas { context, size in
        draw(in: &context, size: size, zoom: zoom, shift: CGSize(width: offset.width + pan.width, height: offset.height + pan.height))
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .contentShape(Rectangle())
      .gesture(magnify)
      .simultaneousGesture(move)
      .onTapGesture(count: 2) {
        withAnimation(.snappy) {
          scale = scale > 1 ? 1 : 2
          offset = .zero
        }
      }
    }
    .background(canvasColor)
    .overlay(alignment: .bottomTrailing) {
      if scene.elements.isEmpty {
        Text("This whiteboard has nothing to draw here.")
          .font(.weave(.callout))
          .foregroundStyle(Color.weave.muted)
          .padding(WeaveSpacing.s4)
      }
    }
    .accessibilityElement()
    .accessibilityLabel("Whiteboard, \(scene.elements.count) shapes")
    .accessibilityValue(scene.elements.filter { $0.kind == .text }.map(\.text).joined(separator: ", "))
  }

  private var canvasColor: Color {
    colorScheme == .dark ? Color(red: 0.07, green: 0.07, blue: 0.08) : .white
  }

  private var magnify: some Gesture {
    MagnifyGesture()
      .updating($pinch) { value, state, _ in state = value.magnification }
      .onEnded { value in
        scale = min(Self.zoom.upperBound, max(Self.zoom.lowerBound, scale * value.magnification))
        if scale == Self.zoom.lowerBound { offset = .zero }
      }
  }

  private var move: some Gesture {
    DragGesture(minimumDistance: scale > 1 ? 0 : .infinity)
      .updating($pan) { value, state, _ in state = value.translation }
      .onEnded { value in
        offset.width += value.translation.width
        offset.height += value.translation.height
      }
  }

  // MARK: Drawing

  private func draw(in context: inout GraphicsContext, size: CGSize, zoom: CGFloat, shift: CGSize) {
    let box = scene.bounds
    guard !box.isNull, box.width > 0 || box.height > 0 else { return }
    let margin: CGFloat = 16
    let fit = min((size.width - margin * 2) / max(box.width, 1), (size.height - margin * 2) / max(box.height, 1))
    let base = min(fit, 2)
    let total = base * zoom
    context.translateBy(x: size.width / 2 + shift.width, y: size.height / 2 + shift.height)
    context.scaleBy(x: total, y: total)
    context.translateBy(x: -box.midX, y: -box.midY)
    for element in scene.elements {
      var layer = context
      layer.opacity = element.opacity
      let center = CGPoint(x: element.x + element.width / 2, y: element.y + element.height / 2)
      if element.angle != 0 {
        layer.translateBy(x: center.x, y: center.y)
        layer.rotate(by: .radians(element.angle))
        layer.translateBy(x: -center.x, y: -center.y)
      }
      draw(element, in: &layer)
    }
  }

  private func draw(_ element: ExcalidrawScene.Element, in context: inout GraphicsContext) {
    let frame = CGRect(x: element.x, y: element.y, width: element.width, height: element.height).standardized
    let stroke = color(element.stroke)
    let style = StrokeStyle(lineWidth: element.strokeWidth, lineCap: .round, lineJoin: .round, dash: element.dashed ? [element.strokeWidth * 4, element.strokeWidth * 3] : [])
    switch element.kind {
    case .rectangle, .ellipse, .diamond:
      let path: Path
      switch element.kind {
      case .ellipse: path = Path(ellipseIn: frame)
      case .diamond:
        path = Path { p in
          p.move(to: CGPoint(x: frame.midX, y: frame.minY))
          p.addLine(to: CGPoint(x: frame.maxX, y: frame.midY))
          p.addLine(to: CGPoint(x: frame.midX, y: frame.maxY))
          p.addLine(to: CGPoint(x: frame.minX, y: frame.midY))
          p.closeSubpath()
        }
      default:
        path = element.rounded ? Path(roundedRect: frame, cornerRadius: min(32, min(frame.width, frame.height) * 0.25)) : Path(frame)
      }
      if let fill = fillColor(element.background) { context.fill(path, with: .color(fill)) }
      context.stroke(path, with: .color(stroke), style: style)
    case .line, .arrow, .freedraw:
      let points = element.points.map { CGPoint(x: element.x + $0.x, y: element.y + $0.y) }
      guard points.count >= 2 else { return }
      var path = Path()
      path.move(to: points[0])
      if element.kind == .freedraw || points.count == 2 {
        points.dropFirst().forEach { path.addLine(to: $0) }
      } else {
        // A gentle curve through the points, like Excalidraw's rounded arrows.
        for index in 1..<points.count {
          let mid = CGPoint(x: (points[index - 1].x + points[index].x) / 2, y: (points[index - 1].y + points[index].y) / 2)
          path.addQuadCurve(to: mid, control: points[index - 1])
        }
        path.addLine(to: points[points.count - 1])
      }
      if element.kind == .line, points.first == points.last, let fill = fillColor(element.background) {
        context.fill(path, with: .color(fill))
      }
      context.stroke(path, with: .color(stroke), style: style)
      if element.kind == .arrow {
        if element.endArrow { arrowhead(from: points[points.count - 2], to: points[points.count - 1], width: element.strokeWidth, color: stroke, in: &context) }
        if element.startArrow { arrowhead(from: points[1], to: points[0], width: element.strokeWidth, color: stroke, in: &context) }
      }
    case .text:
      let lines = element.text.split(separator: "\n", omittingEmptySubsequences: false)
      let lineHeight = element.fontSize * 1.25
      for (index, line) in lines.enumerated() {
        let text = Text(String(line)).font(.system(size: element.fontSize, weight: .regular, design: .rounded)).foregroundColor(stroke)
        let y = frame.minY + lineHeight * (CGFloat(index) + 0.5)
        switch element.textAlign {
        case "center": context.draw(text, at: CGPoint(x: frame.midX, y: y), anchor: .center)
        case "right": context.draw(text, at: CGPoint(x: frame.maxX, y: y), anchor: .trailing)
        default: context.draw(text, at: CGPoint(x: frame.minX, y: y), anchor: .leading)
        }
      }
    }
  }

  private func arrowhead(from start: CGPoint, to end: CGPoint, width: Double, color: Color, in context: inout GraphicsContext) {
    let angle = atan2(end.y - start.y, end.x - start.x)
    let length = max(10, width * 6)
    let spread = Double.pi / 7
    var path = Path()
    path.move(to: CGPoint(x: end.x - length * cos(angle - spread), y: end.y - length * sin(angle - spread)))
    path.addLine(to: end)
    path.addLine(to: CGPoint(x: end.x - length * cos(angle + spread), y: end.y - length * sin(angle + spread)))
    context.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
  }

  private func fillColor(_ hex: String) -> Color? {
    hex == "transparent" || hex.isEmpty ? nil : color(hex)
  }

  /// An Excalidraw color; in dark mode inverted and hue-rotated back, as Excalidraw does.
  private func color(_ value: String) -> Color {
    guard let rgb = ExcalidrawColor.rgb(value) else { return colorScheme == .dark ? .white : .black }
    let (r, g, b) = colorScheme == .dark ? ExcalidrawColor.darkened(rgb) : rgb
    return Color(red: r, green: g, blue: b)
  }
}

nonisolated enum ExcalidrawColor {
  /// `#rgb`, `#rrggbb` or a few CSS names, as 0...1 components.
  static func rgb(_ value: String) -> (Double, Double, Double)? {
    let named: [String: String] = ["black": "#000000", "white": "#ffffff", "red": "#ff0000", "green": "#008000", "blue": "#0000ff"]
    var hex = (named[value.lowercased()] ?? value).trimmingCharacters(in: .whitespaces)
    guard hex.hasPrefix("#") else { return nil }
    hex.removeFirst()
    if hex.count == 3 { hex = hex.map { "\($0)\($0)" }.joined() }
    if hex.count == 8 { hex = String(hex.prefix(6)) }
    guard hex.count == 6, let int = UInt32(hex, radix: 16) else { return nil }
    return (Double((int >> 16) & 0xFF) / 255, Double((int >> 8) & 0xFF) / 255, Double(int & 0xFF) / 255)
  }

  /// Invert, then rotate the hue 180° so blue stays blue: dark ink turns light,
  /// pastel fills turn deep, the way Excalidraw's dark theme filter looks.
  static func darkened(_ rgb: (Double, Double, Double)) -> (Double, Double, Double) {
    let inverted = (1 - rgb.0, 1 - rgb.1, 1 - rgb.2)
    // A 180° hue rotation keeps luminance; with inversion that swaps light and dark only.
    let l = 0.2126 * inverted.0 + 0.7152 * inverted.1 + 0.0722 * inverted.2
    let rotated = (2 * l - inverted.0, 2 * l - inverted.1, 2 * l - inverted.2)
    let clamp: (Double) -> Double = { min(1, max(0, $0 * 0.93 + 0.04)) }
    return (clamp(rotated.0), clamp(rotated.1), clamp(rotated.2))
  }
}
