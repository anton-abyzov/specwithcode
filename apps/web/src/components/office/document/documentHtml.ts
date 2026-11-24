/**
 * A standalone, script-free HTML page of a document, for Export PDF. Built as
 * text from the model with every value escaped; pictures are the model's own
 * data URLs, links are kept only for http, https and mailto.
 */
import type { DocumentBlock, DocumentRun, OfficeDocument } from "@specweave-studio/contracts";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_HREF_RE = /^(https?:\/\/|mailto:)[^\s"<>]+$/i;
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

function runHtml(run: DocumentRun): string {
  let html = esc(run.text).replace(/\n/g, "<br>").replace(/\t/g, "&emsp;");
  if (run.code) html = `<code>${html}</code>`;
  if (run.bold) html = `<strong>${html}</strong>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.underline) html = `<u>${html}</u>`;
  if (run.strike) html = `<s>${html}</s>`;
  if (run.color && /^#[0-9A-Fa-f]{6}$/.test(run.color)) {
    html = `<span style="color:${run.color}">${html}</span>`;
  }
  if (run.href && SAFE_HREF_RE.test(run.href)) html = `<a href="${esc(run.href)}">${html}</a>`;
  return html;
}

const runsHtml = (runs: ReadonlyArray<DocumentRun>) => runs.map(runHtml).join("") || "<br>";

const alignStyle = (align: string | undefined) =>
  align && align !== "left" ? ` style="text-align:${align}"` : "";

function listHtml(block: Extract<DocumentBlock, { type: "list" }>): string {
  const tag = block.ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let depth = 0;
  let open = false;
  for (const item of block.items) {
    const level = Math.min(item.level, depth + (open ? 1 : 0));
    while (depth < level) {
      html += `<${tag}>`;
      depth += 1;
      open = false;
    }
    while (depth > level) {
      html += `</li></${tag}>`;
      depth -= 1;
    }
    if (open) html += "</li>";
    html += `<li>${runsHtml(item.runs)}`;
    open = true;
  }
  if (open) html += "</li>";
  while (depth > 0) {
    html += `</${tag}></li>`;
    depth -= 1;
  }
  return `${html}</${tag}>`;
}

function blockHtml(block: DocumentBlock): string {
  switch (block.type) {
    case "heading":
      return `<h${block.level}${alignStyle(block.align)}>${runsHtml(block.runs)}</h${block.level}>`;
    case "paragraph":
      if (block.style === "quote") return `<blockquote>${runsHtml(block.runs)}</blockquote>`;
      if (block.style === "code") {
        return `<pre>${esc(block.runs.map((run) => run.text).join(""))}</pre>`;
      }
      return `<p${alignStyle(block.align)}>${runsHtml(block.runs)}</p>`;
    case "list":
      return listHtml(block);
    case "table":
      return `<table>${block.rows
        .map(
          (row) =>
            `<tr>${row.cells
              .map((cell) => {
                const tag = cell.header ? "th" : "td";
                return `<${tag}>${cell.paragraphs.map((runs) => `<p>${runsHtml(runs)}</p>`).join("")}</${tag}>`;
              })
              .join("")}</tr>`,
        )
        .join("")}</table>`;
    case "image": {
      if (!DATA_IMAGE_RE.test(block.src)) return "";
      const size = block.width ? ` width="${Math.round(block.width)}"` : "";
      return `<p${alignStyle(block.align)}><img src="${block.src}" alt="${esc(block.alt ?? "")}"${size}></p>`;
    }
    case "divider":
      return "<hr>";
  }
}

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;color:#111;background:#fff;font:11pt/1.45 Calibri,Carlito,"Segoe UI",Helvetica,Arial,sans-serif}
h1{font-size:16pt;margin:18pt 0 4pt}h2{font-size:14pt;margin:12pt 0 4pt}h3{font-size:13pt;margin:12pt 0 4pt}
h4,h5,h6{font-size:11pt;margin:12pt 0 4pt}
p{margin:0 0 8pt}ul,ol{margin:0 0 8pt;padding-left:24pt}li{margin:0 0 3pt}
blockquote{margin:6pt 36pt;font-style:italic;color:#404040}
pre{margin:0;padding:2pt 6pt;background:#f2f2f2;font:10pt Consolas,"Liberation Mono",Menlo,monospace;white-space:pre-wrap}
code{font-family:Consolas,"Liberation Mono",Menlo,monospace}
table{border-collapse:collapse;width:100%;margin:0 0 8pt}th,td{border:1px solid #000;padding:2pt 5pt;vertical-align:top;text-align:left}
th p,td p{margin:0}
img{max-width:100%;height:auto}hr{border:0;border-top:1px solid #000;margin:6pt 0}
a{color:#0563c1}
`;

/** The page Export PDF prints. */
export function documentPrintHtml(document: OfficeDocument, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${document.blocks
    .map(blockHtml)
    .join("\n")}</body></html>`;
}
