import SwiftUI
import Weave

/// A comma- or tab-separated file as rows of cells. Quoted fields may hold
/// separators, doubled quotes and line breaks (RFC 4180). The first row is
/// the header. At most `maxRows` rows are kept so a huge export cannot stall
/// the phone; `truncated` says when rows were left out.
nonisolated struct CSVTable: Equatable, Sendable {
  var header: [String]
  var rows: [[String]]
  var truncated: Bool

  static let maxRows = 2_000

  static func parse(_ text: String, separator: Character = ",", maxRows: Int = maxRows) -> CSVTable {
    var records: [[String]] = []
    var record: [String] = []
    var field = ""
    var quoted = false
    var truncated = false
    var iterator = (text.hasPrefix("\u{FEFF}") ? String(text.dropFirst()) : text).makeIterator()
    var pending: Character?

    func endField() {
      record.append(field)
      field = ""
    }
    func endRecord() {
      endField()
      // A blank line is not a row.
      if !(record.count == 1 && record[0].isEmpty) { records.append(record) }
      record = []
    }

    while let character = pending ?? iterator.next() {
      pending = nil
      if records.count > maxRows {
        truncated = true
        break
      }
      if quoted {
        if character == "\"" {
          let next = iterator.next()
          if next == "\"" {
            field.append("\"")
          } else {
            quoted = false
            pending = next
          }
        } else {
          field.append(character)
        }
        continue
      }
      switch character {
      case "\"" where field.isEmpty:
        quoted = true
      case separator:
        endField()
      case "\n", "\r\n":
        endRecord()
      case "\r":
        endRecord()
      default:
        field.append(character)
      }
    }
    if !field.isEmpty || !record.isEmpty { endRecord() }
    if records.count > maxRows + 1 {
      records = Array(records.prefix(maxRows + 1))
      truncated = true
    }

    let header = records.first ?? []
    let width = records.map(\.count).max() ?? 0
    func padded(_ row: [String]) -> [String] { row + Array(repeating: "", count: max(0, width - row.count)) }
    return CSVTable(header: padded(header), rows: records.dropFirst().map(padded), truncated: truncated)
  }

  /// True when every non-empty cell in the column reads as a number, so it aligns right.
  func isNumeric(column: Int) -> Bool {
    let values = rows.compactMap { column < $0.count ? $0[column] : nil }.filter { !$0.isEmpty }
    guard !values.isEmpty else { return false }
    return values.allSatisfy { Double($0.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "%", with: "")) != nil }
  }
}

/// A sheet on the phone: a sticky header row, zebra rows, columns sized to
/// their content between a minimum and a maximum, scrolling both ways.
struct CSVTableView: View {
  let table: CSVTable

  @ScaledMetric(relativeTo: .callout) private var minColumn: CGFloat = 72
  @ScaledMetric(relativeTo: .callout) private var maxColumn: CGFloat = 240

  var body: some View {
    let widths = columnWidths()
    let numeric = Set((0..<table.header.count).filter { table.isNumeric(column: $0) })
    ScrollView([.vertical, .horizontal]) {
      LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
        Section {
          ForEach(table.rows.indices, id: \.self) { index in
            row(table.rows[index], widths: widths, numeric: numeric, header: false)
              .background(index.isMultiple(of: 2) ? Color.clear : Color.weave.sunken.opacity(0.6))
          }
          if table.truncated {
            Text("Showing the first \(CSVTable.maxRows) rows")
              .font(.weave(.caption))
              .foregroundStyle(Color.weave.muted)
              .padding(WeaveSpacing.s3)
          }
        } header: {
          row(table.header, widths: widths, numeric: [], header: true)
            .background(Color.weave.panel)
            .overlay(alignment: .bottom) { WeaveDivider() }
        }
      }
      .padding(.bottom, WeaveSpacing.s8)
    }
    .background(Color.weave.canvas)
  }

  private func row(_ cells: [String], widths: [CGFloat], numeric numericColumns: Set<Int>, header: Bool) -> some View {
    HStack(alignment: .top, spacing: 0) {
      ForEach(cells.indices, id: \.self) { column in
        let numeric = numericColumns.contains(column)
        Text(cells[column])
          .font(.weave(.callout, weight: header ? .semibold : nil))
          .monospacedDigit()
          .foregroundStyle(Color.weave.ink)
          .lineLimit(header ? 2 : 4)
          .multilineTextAlignment(numeric ? .trailing : .leading)
          .frame(width: column < widths.count ? widths[column] : minColumn, alignment: numeric ? .trailing : .leading)
          .padding(.horizontal, WeaveSpacing.s3)
          .padding(.vertical, WeaveSpacing.s2)
          .textSelection(.enabled)
      }
    }
  }

  /// About 8 points per character of the column's longest cell (first 200 rows).
  private func columnWidths() -> [CGFloat] {
    let sample = [table.header] + table.rows.prefix(200)
    let columns = table.header.count
    return (0..<columns).map { column in
      let longest = sample.map { column < $0.count ? $0[column].count : 0 }.max() ?? 0
      return min(maxColumn, max(minColumn, CGFloat(longest) * 8.2))
    }
  }
}
