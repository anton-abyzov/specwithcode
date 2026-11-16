// @effect-diagnostics nodeBuiltinImport:off - The wrapper's script hash is the bytes the browser hashes.
import { createHash } from "node:crypto";

/**
 * A framed HTML file. The wrapper is what the app's frame loads. It frames the
 * page, and its frame-src is what stops that page from navigating away. The
 * page itself gets the locked policy and a link script.
 */

/**
 * Relays a link open from the page to the app, and nothing else. A page can
 * post any object; forwarding it would let a script open a site the reader
 * did not click. Does nothing when this document is the top window, so a tab
 * opened on the wrapper cannot loop. The bytes are hashed into the wrapper's
 * script-src; keep them exact.
 */
export const HTML_FILE_RELAY_SCRIPT =
  '(function(){var f=document.querySelector("iframe");addEventListener("message",function(e){if(!f||!f.contentWindow||!e.data||typeof e.data!=="object")return;if(e.source===f.contentWindow){if(parent===window)return;var d=e.data,p=d.params,u=p&&typeof p.url==="string"?p.url:"";if(d.jsonrpc!=="2.0"||d.method!=="ui/open-link"||typeof d.id!=="string"||d.id.indexOf("studio-file-link-")!==0||(u.indexOf("https://")!==0&&u.indexOf("http://")!==0))return;parent.postMessage({jsonrpc:"2.0",id:d.id,method:"ui/open-link",params:{url:u}},"*");}else if(e.source===parent&&parent!==window)f.contentWindow.postMessage(e.data,"*");});})();';

const HTML_FILE_RELAY_HASH = createHash("sha256").update(HTML_FILE_RELAY_SCRIPT).digest("base64");

/** A trusted primary click on an http(s) link to another site asks the app to open it. */
export const HTML_FILE_LINK_SCRIPT =
  '(function(){if(parent===window)return;var n=0;addEventListener("click",function(e){if(!e.isTrusted||e.button!==0||e.defaultPrevented||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var l=e.target;while(l&&l.tagName!=="A")l=l.parentElement;if(!l)return;var u;try{u=new URL(l.href,location.href);}catch(x){return;}if(u.protocol!=="http:"&&u.protocol!=="https:")return;if(u.host===location.host)return;e.preventDefault();parent.postMessage({jsonrpc:"2.0",id:"studio-file-link-"+(++n),method:"ui/open-link",params:{url:u.href}},"*");},true);})();';

const HTML_FILE_LINK_HASH = createHash("sha256").update(HTML_FILE_LINK_SCRIPT).digest("base64");

/**
 * Locked policy for a framed file. `'self'` is the asset server. script-src
 * is only the link script: the page's own scripts do not run, so they cannot
 * post an open for a URL the reader did not click.
 */
export const HTML_FILE_LOCKED_POLICY = `sandbox allow-scripts allow-forms; default-src 'none'; script-src 'sha256-${HTML_FILE_LINK_HASH}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; form-action 'none'; base-uri 'none'`;

const LINK_SCRIPT_MARKUP = `<script data-studio-file-links>${HTML_FILE_LINK_SCRIPT}</script>`;

export type HtmlFrameMode = "wrapper" | "locked" | "top";

/**
 * `studio-frame=1` is the app's frame and gets the wrapper. `studio-frame=page`
 * is the page inside that wrapper. An iframe navigation with no parameter also
 * gets the wrapper. A top-level document load keeps today's policy. Anything
 * else, including a missing Sec-Fetch-Dest, is locked.
 */
export function htmlFrameMode(input: {
  readonly searchParams: URLSearchParams;
  readonly secFetchDest: string | undefined;
}): HtmlFrameMode {
  const frame = input.searchParams.get("studio-frame");
  if (frame === "1") return "wrapper";
  if (frame === "page") return "locked";
  if (input.secFetchDest === "iframe") return "wrapper";
  if (input.secFetchDest === "document") return "top";
  return "locked";
}

/** The same asset URL, asking for the locked page, as a same-origin path. */
export function htmlPreviewPagePath(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.set("studio-frame", "page");
  const search = params.toString();
  return `${url.pathname}${search.length > 0 ? `?${search}` : ""}`;
}

export function htmlPreviewWrapperPolicy(): string {
  return `sandbox allow-scripts; default-src 'none'; script-src 'sha256-${HTML_FILE_RELAY_HASH}'; style-src 'unsafe-inline'; frame-src 'self'`;
}

export function htmlPreviewResponseHeaders(
  mode: HtmlFrameMode,
  topPolicy: string,
): Record<string, string> {
  const policy =
    mode === "wrapper"
      ? htmlPreviewWrapperPolicy()
      : mode === "locked"
        ? HTML_FILE_LOCKED_POLICY
        : topPolicy;
  return {
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": policy,
    "Content-Type": "text/html; charset=utf-8",
    Vary: "Sec-Fetch-Dest",
    "X-Content-Type-Options": "nosniff",
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Script-free shell except the hashed relay. The iframe holds the page. */
export function htmlPreviewWrapperDocument(pagePath: string): string {
  const src = escapeAttribute(pagePath);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe sandbox="allow-scripts allow-forms" src="${src}"></iframe><script>${HTML_FILE_RELAY_SCRIPT}</script></body></html>`;
}

/** Adds the link script once, before the last body end, or at the end. */
export function injectHtmlFileLinkScript(html: string): string {
  if (html.includes(LINK_SCRIPT_MARKUP)) return html;
  const close = html.toLowerCase().lastIndexOf("</body>");
  return close < 0
    ? `${html}${LINK_SCRIPT_MARKUP}`
    : `${html.slice(0, close)}${LINK_SCRIPT_MARKUP}${html.slice(close)}`;
}
