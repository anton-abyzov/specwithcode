import Foundation
import Testing
@testable import SWCFeatures
@testable import Weave

@Suite("Diagrams, sheets and whiteboards")
struct ArtifactParsingTests {
  @Test("A closed mermaid fence is a diagram; one still streaming stays code")
  func mermaidFences() {
    #expect(MarkdownParser.parse("```mermaid\nflowchart TD\n  A --> B\n```") == [.diagram(source: "flowchart TD\n  A --> B")])
    #expect(MarkdownParser.parse("```Mermaid\ngraph LR\nA-->B\n```") == [.diagram(source: "graph LR\nA-->B")])
    #expect(MarkdownParser.parse("```mermaid\nflowchart TD\n  A --> B") == [.code(language: "mermaid", text: "flowchart TD\n  A --> B")])
    #expect(MarkdownParser.parse("```mermaid\n```") == [.code(language: "mermaid", text: "")])
    #expect(MarkdownParser.parse("```js\nlet a = 1\n```") == [.code(language: "js", text: "let a = 1")])
  }

  @Test("Mermaid's settings match the web app's and theme from the palette")
  func mermaidConfig() {
    for key in ["securityLevel", "htmlLabels", "themeCSS", "maxTextSize", "startOnLoad", "secure"] {
      #expect(MermaidConfig.secureKeys.contains(key))
    }
    #expect(MermaidConfig.bootstrap.contains("securityLevel: \"strict\""))
    #expect(MermaidConfig.bootstrap.contains("htmlLabels: false"))
    #expect(MermaidConfig.themeVariables(dark: true)["primaryTextColor"] == "#f3eff9")
    #expect(MermaidConfig.themeVariables(dark: false)["primaryTextColor"] == "#241523")
  }

  @Test("The SVG page loads nothing and runs nothing")
  func mermaidPagePolicy() {
    let page = MermaidConfig.page(svg: "<svg></svg>", zoomable: true)
    #expect(page.contains("default-src 'none'"))
    #expect(!page.contains("script-src"))
    #expect(page.contains("maximum-scale=8"))
    #expect(MermaidConfig.page(svg: "<svg></svg>", zoomable: false).contains("user-scalable=no"))
  }

  @Test("CSV keeps quoted separators, doubled quotes and line breaks")
  func csv() {
    let table = CSVTable.parse("Name,Notes,Count\nA,\"one, two\",3\n\"B \"\"quoted\"\"\",\"line\nbreak\",10\n\nC,,\n")
    #expect(table.header == ["Name", "Notes", "Count"])
    #expect(table.rows == [["A", "one, two", "3"], ["B \"quoted\"", "line\nbreak", "10"], ["C", "", ""]])
    #expect(table.isNumeric(column: 2))
    #expect(!table.isNumeric(column: 0))
    #expect(!table.truncated)
  }

  @Test("A byte-order mark is not part of the first header")
  func bom() {
    #expect(CSVTable.parse("\u{FEFF}Name,Count\nA,1\n").header == ["Name", "Count"])
  }

  @Test("The diagram scrub follows the web app's forbid list")
  func scrubList() {
    for name in ["script", "foreignObject", "animate", "image", "src"] {
      #expect(MermaidConfig.bootstrap.contains(name))
    }
    #expect(!MermaidConfig.bootstrap.contains("data:image/"))
  }

  @Test("A huge drawing keeps at most the point budget")
  func whiteboardPointBudget() throws {
    let points = (0..<(ExcalidrawScene.maxPoints + 10)).map { "[\($0),0]" }.joined(separator: ",")
    let json = #"{"type":"excalidraw","elements":[{"type":"freedraw","x":0,"y":0,"width":1,"height":1,"points":["# + points + #"]},{"type":"rectangle","x":0,"y":0,"width":10,"height":10}]}"#
    let scene = try #require(ExcalidrawScene.decode(json))
    #expect(scene.elements.map(\.kind) == [.rectangle])
    #expect(scene.bounds.width >= 10)
  }

  @Test("TSV, ragged rows and CRLF line ends")
  func tsv() {
    let table = CSVTable.parse("a\tb\r\n1\r\n2\t3\t4\r\n", separator: "\t")
    #expect(table.header == ["a", "b", ""])
    #expect(table.rows == [["1", "", ""], ["2", "3", "4"]])
  }

  @Test("A huge sheet keeps its first rows and says so")
  func truncated() {
    let text = (["h"] + (0..<50).map(String.init)).joined(separator: "\n")
    let table = CSVTable.parse(text, maxRows: 10)
    #expect(table.rows.count == 10)
    #expect(table.truncated)
  }

  @Test("An Excalidraw scene keeps live shapes, points and text")
  func excalidraw() throws {
    let scene = try #require(ExcalidrawScene.decode("""
    {"type":"excalidraw","elements":[
      {"type":"rectangle","x":0,"y":0,"width":100,"height":50,"strokeColor":"#1e1e1e","backgroundColor":"#a5d8ff","roundness":{"type":3}},
      {"type":"arrow","x":100,"y":25,"width":50,"height":0,"points":[[0,0],[50,0]],"endArrowhead":"arrow"},
      {"type":"text","x":10,"y":10,"width":80,"height":20,"text":"Hello","fontSize":16},
      {"type":"rectangle","x":500,"y":500,"width":10,"height":10,"isDeleted":true},
      {"type":"image","x":0,"y":0,"width":10,"height":10}
    ],"appState":{"viewBackgroundColor":"#ffffff"}}
    """))
    #expect(scene.elements.map(\.kind) == [.rectangle, .arrow, .text])
    #expect(scene.elements[0].rounded)
    #expect(scene.elements[1].endArrow && !scene.elements[1].startArrow)
    #expect(scene.elements[2].text == "Hello")
    #expect(scene.bounds.maxX < 200)
    #expect(ExcalidrawScene.decode("not json") == nil)
  }

  @Test("Dark mode turns dark ink light and keeps blue blue")
  func excalidrawDark() throws {
    let ink = ExcalidrawColor.darkened(try #require(ExcalidrawColor.rgb("#1e1e1e")))
    #expect(ink.0 > 0.8 && ink.1 > 0.8 && ink.2 > 0.8)
    let blue = ExcalidrawColor.darkened(try #require(ExcalidrawColor.rgb("#a5d8ff")))
    #expect(blue.2 > blue.0)
    #expect(ExcalidrawColor.rgb("#fff") != nil)
    #expect(ExcalidrawColor.rgb("transparent") == nil)
  }

  @Test("Sheets and whiteboards are links the viewer opens")
  func kinds() {
    #expect(HostFileLink.kind(of: "/a/checks.csv") == .sheet)
    #expect(HostFileLink.kind(of: "/a/checks.TSV") == .sheet)
    #expect(HostFileLink.kind(of: "/a/plan.excalidraw") == .whiteboard)
    #expect(HostFileLink.hostPath("/Users/me/plan.excalidraw") == "/Users/me/plan.excalidraw")
  }
}
