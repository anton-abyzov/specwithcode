import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { remarkPreserveWindowsPathText } from "./markdown-windows-paths";

function render(text: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkPreserveWindowsPathText]}>{text}</ReactMarkdown>,
  );
}

describe("remarkPreserveWindowsPathText", () => {
  it.each([
    String.raw`See C:\Users\dev\.config\settings.json for details.`,
    String.raw`See c:\.config\_cache\settings.json for details.`,
    String.raw`Open (D:\project\[draft]\file.ts).`,
    String.raw`Read C:\project\!notes.md and D:\other\#draft.md.`,
    String.raw`C:\project\.config has settings.`,
  ])("preserves punctuation separators in %s", (text) => {
    expect(render(text)).toBe(`<p>${text}</p>`);
  });

  it("keeps ordinary Markdown escapes outside the path", () => {
    expect(render(String.raw`\*literal\* and C:\project\.config, then \_plain\_.`)).toBe(
      String.raw`<p>*literal* and C:\project\.config, then _plain_.</p>`,
    );
  });

  it("leaves inline code and emphasis intact", () => {
    expect(render("`C:\\project\\.config` and **important**")).toBe(
      "<p><code>C:\\project\\.config</code> and <strong>important</strong></p>",
    );
  });
});
