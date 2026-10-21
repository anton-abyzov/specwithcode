import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { CHAT_REMARK_GFM } from "./markdown-gfm";

const render = (markdown: string) =>
  renderToStaticMarkup(<ReactMarkdown remarkPlugins={[CHAT_REMARK_GFM]}>{markdown}</ReactMarkdown>);

describe("CHAT_REMARK_GFM", () => {
  it("leaves text between two home paths as it is", () => {
    const html = render(
      "Keep receipts under ~/.local/share/receipts/. Prod reads: KUBECONFIG=~/.kube/prod.yaml, read-only.",
    );
    expect(html).not.toContain("<del>");
    expect(html).toContain("~/.local/share/receipts/");
    expect(html).toContain("KUBECONFIG=~/.kube/prod.yaml");
  });

  it("still strikes double tildes and keeps tables", () => {
    expect(render("~~gone~~ stays")).toContain("<del>gone</del>");
    expect(render("| a |\n| - |\n| 1 |")).toContain("<table>");
  });
});
