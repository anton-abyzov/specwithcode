/**
 * A Markdown file as the small page on its card: the title, facts and body the
 * viewer reads from `markdownDocument`, in the viewer's proportions. Loaded on
 * the first Markdown card, since it brings a server renderer with it.
 */
import {
  headingText,
  markdownDocument,
  markdownOpeningTitle,
} from "@specweave-studio/shared/reportDocument";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** More than a card's page can show, so a long file costs what a short one does. */
const SOURCE_CHARS = 4000;
const MAX_PROPERTIES = 3;
const TITLE_CHARS = 200;

const SERIF = `"New York",ui-serif,"Iowan Old Style",Charter,"Noto Serif",Georgia,serif`;
const SANS = `-apple-system,"Segoe UI",system-ui,sans-serif`;
const MONO = `ui-monospace,Menlo,Consolas,monospace`;
const PAGE_STYLE = `
html,body{background:#fff}
body{margin:0;padding:38px 50px;color:#3a3833;font:400 15px/1.6 ${SERIF}}
h1{margin:0 0 14px;color:#1b1a17;font:500 36px/1.14 ${SERIF};letter-spacing:-.012em}
h2{margin:22px 0 8px;color:#1b1a17;font:500 22px/1.25 ${SERIF}}
h3,h4,h5,h6{margin:18px 0 6px;color:#1b1a17;font:600 16px/1.3 ${SERIF}}
p{margin:0 0 10px}
ul,ol{margin:0 0 10px;padding-left:22px}
li{margin:0 0 3px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:3px 22px;margin:0 0 18px;padding:9px 0;border-block:1px solid #e5e3dd;color:#6c6a63;font:12.5px/1.4 ${SANS}}
dd{margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
table{width:100%;margin:0 0 12px;border-collapse:collapse;font:12.5px/1.4 ${SANS}}
th,td{padding:5px 8px;border-bottom:1px solid #e5e3dd;text-align:left}
th{color:#1b1a17;font-weight:600}
code{padding:.1em .3em;border-radius:4px;background:#f3f2ee;font:.86em/1.4 ${MONO}}
pre{margin:0 0 10px;padding:9px 12px;border-radius:8px;background:#f5f4f0;overflow:hidden}
pre code{padding:0;background:none}
blockquote{margin:0 0 10px;padding-left:14px;border-left:3px solid #e5e3dd;color:#6c6a63}
hr{margin:16px 0;border:0;border-top:1px solid #e5e3dd}
`;

/** Nothing on a card's page loads or links anywhere. */
const INERT_COMPONENTS = {
  img: () => null,
  a: ({ children }: { readonly children?: React.ReactNode }) => <span>{children}</span>,
};

export function markdownPage(text: string): {
  readonly html: string;
  readonly title: string | null;
} {
  // The whole file, so a long frontmatter still closes; only what the page can show is drawn.
  const document = markdownDocument(text);
  const title = document.title ?? markdownOpeningTitle(document.body);
  const properties = document.properties.slice(0, MAX_PROPERTIES);
  const body = renderToStaticMarkup(
    <>
      {document.title ? <h1>{document.title.slice(0, TITLE_CHARS)}</h1> : null}
      {properties.length > 0 ? (
        <dl>
          {properties.map((property) => (
            <div key={property.label} style={{ display: "contents" }}>
              <dt>{property.label}</dt>
              <dd>{property.chips?.join(" · ") ?? headingText(property.markdown)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={INERT_COMPONENTS} skipHtml>
        {document.body.slice(0, SOURCE_CHARS)}
      </ReactMarkdown>
    </>,
  );
  return {
    html: `<!doctype html><html><head><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`,
    title: title === null ? null : title.slice(0, TITLE_CHARS),
  };
}
