import { verifyOutputFixture } from "./verify.mjs";
import { Suspense, useState } from "react";
import { createRoot } from "react-dom/client";
import { ToolCodePanel } from "../../src/components/chat/toolOutputPresentation";
import { HighlightedTokens } from "../../src/components/chat/HighlightedTokens";
import { RenderErrorBoundary } from "../../src/components/RenderErrorBoundary";
import { toolOutputContext, rawToolOutputText } from "../../src/lib/outputLanguage";
import "./fixture.css";

const theme = new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
localStorage.setItem("studio:theme", theme);
document.documentElement.classList.toggle("dark", theme === "dark");
const samples = [
  ["jsx", "export const View = () => <main>Hello</main>;\n"],
  ["typescript", "export interface Item { name: string; count: number }\n"],
  ["javascript", "export const sum = (a, b) => a + b;\n"],
  [
    "java",
    'public class Demo { public static void main(String[] args) { System.out.println("Hello"); } }\n',
  ],
  ["c", '#include <stdio.h>\nint main(void) { printf("Hello"); return 0; }\n'],
  ["cpp", '#include <iostream>\nint main() { std::cout << "Hello"; }\n'],
  ["shellscript", '#!/bin/sh\nname="world"\nprintf "%s" "$name"\n'],
  ["html", "<!doctype html>\n<html><body><h1>Hello</h1></body></html>\n"],
  ["markdown", "# Title\n\n**bold** and [link](https://example.test)\n"],
  [
    "tsx",
    'import React from "react";\r\n\texport const View = () => <main title="Hello">Hello</main>;\r\n\r\n',
  ],
  [
    "python",
    "from pathlib import Path\n\ndef read(path: str):\n    return Path(path).read_text()\n",
  ],
  ["rust", 'fn main() {\n    let count: u32 = 42;\n    println!("{}", count);\n}\n'],
  ["go", 'package main\nimport "fmt"\nfunc main() { fmt.Println("Hello") }\n'],
  ["json", '{\r\n\t"ready": true, "count": 42\r\n}\r\n'],
  ["yaml", "name: sample\nitems:\n  - enabled: true\n"],
  ["toml", '[project]\nname = "demo"\nenabled = true\n'],
  ["sql", "SELECT name, count(*) FROM users WHERE active = true GROUP BY name;\n"],
  ["css", ".card { color: #334455; display: flex; }\n"],
];
const large = "export const view = <div>large output</div>;\n".repeat(26000).slice(0, 1024 * 1024);
const bytes: Record<string, string> = Object.fromEntries(samples);
bytes.large = large;
Object.assign(window, { fixtureBytes: bytes, copied: "", verifyOutputFixture });
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async (text: string) => {
      Object.assign(window, { copied: text });
    },
  },
});
function Fixture() {
  const [chunk, setChunk] = useState("export const View = () => <");
  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "auto",
        padding: 24,
        color: theme === "dark" ? "#eeeeee" : "#202020",
      }}
    >
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Source output · {theme}</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16 }}>
        {samples.map(([language, text]) => (
          <div key={language} id={language}>
            <ToolCodePanel
              label={language!}
              text={rawToolOutputText({
                type: "dynamic_tool",
                output: [{ type: "text", language, text }],
              })!}
              context={toolOutputContext({
                type: "dynamic_tool",
                output: [{ type: "text", language, text }],
              })}
            />
          </div>
        ))}
        <div id="mixed">
          <ToolCodePanel
            label="Mixed logs"
            text={'src/View.tsx:1:export const a = 1\nPASS build\n{"ready":true}\n'}
            context={{ command: "rg const src" }}
          />
        </div>
        <div id="ansi">
          <ToolCodePanel label="ANSI" text={"\u001b[32mPASS\u001b[0m\r\n"} />
        </div>
        <div id="unknown">
          <ToolCodePanel
            label="Unknown"
            text={"<unknown>literal</unknown>\n"}
            language="not-a-grammar"
          />
        </div>
        <div id="stream">
          <button onClick={() => setChunk("export const View = () => <main>streamed</main>;\r\n")}>
            Append stream
          </button>
          <ToolCodePanel
            label="Stream"
            text={chunk}
            context={{ filePath: "View.tsx", streaming: true }}
          />
        </div>
        <div id="shared">
          <pre>
            <RenderErrorBoundary fallback="failed">
              <Suspense fallback="loading">
                <HighlightedTokens
                  code={"unknown grammar stays readable\r\n"}
                  language="not-a-grammar"
                  theme={theme}
                />
              </Suspense>
            </RenderErrorBoundary>
          </pre>
        </div>
      </div>
      <div id="large" style={{ marginTop: 20 }}>
        <ToolCodePanel label="Large" text={large} language="tsx" />
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
