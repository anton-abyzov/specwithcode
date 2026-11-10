// Anonymous download counts for the marketing site.
//
// Cloudflare Web Analytics has no custom events, so clicks on download links
// and copies of the install command are sent to the relay's site-events
// endpoint with navigator.sendBeacon. The payload carries only the event name,
// platform, asset suffix and page path: no cookies, no storage, no identifiers.
// Sending never delays navigation and is skipped when Do Not Track is on.

import {
  CRASH_REPORT_DEFAULT_RELAY_ORIGIN,
  SITE_EVENT_PATH,
  siteEventPlatformForAsset,
  type SiteEvent,
} from "@specweave-studio/shared/crashReport";

/** Marks an element whose activation counts as a download click. */
export const SITE_EVENT_DOWNLOAD_ATTR = "data-download-track";
/** Marks an element whose copied text counts as an install-command copy. */
export const SITE_EVENT_COPY_ATTR = "data-install-copy";

export function siteEventsEndpoint(origin: string | undefined | null): string {
  const raw = (origin ?? "").trim() || CRASH_REPORT_DEFAULT_RELAY_ORIGIN;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("scheme");
    return `${url.origin}${SITE_EVENT_PATH}`;
  } catch {
    return `${CRASH_REPORT_DEFAULT_RELAY_ORIGIN}${SITE_EVENT_PATH}`;
  }
}

/**
 * Picks the asset suffix for a download link: an explicit `data-asset` or
 * `data-track-asset` wins, else the suffix of the linked file name
 * (`SpecWithCode-1.2.3-arm64.dmg` becomes `arm64.dmg`). Links to pages, such
 * as the releases page, have no asset.
 */
export function assetForDownloadLink(
  dataset: { readonly asset?: string; readonly trackAsset?: string },
  href: string | null | undefined,
): string | undefined {
  const explicit = dataset.asset?.trim() || dataset.trackAsset?.trim();
  if (explicit) return explicit.slice(0, 60);
  if (!href) return undefined;
  let fileName: string;
  try {
    const path = new URL(href, "https://example.invalid").pathname;
    fileName = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
  } catch {
    return undefined;
  }
  if (!/\.[A-Za-z0-9]+$/u.test(fileName)) return undefined;
  const dash = fileName.lastIndexOf("-");
  const suffix = (dash >= 0 ? fileName.slice(dash + 1) : fileName).slice(0, 60);
  return /^[A-Za-z0-9._+-]+$/u.test(suffix) ? suffix : undefined;
}

export function buildSiteEvent(
  event: SiteEvent["event"],
  asset: string | undefined,
  page: string,
): SiteEvent {
  const safePage = /^\/[A-Za-z0-9/_-]{0,60}$/u.test(page) ? page : undefined;
  return {
    v: 1,
    event,
    platform: asset ? siteEventPlatformForAsset(asset) : "other",
    ...(asset ? { asset } : {}),
    ...(safePage ? { page: safePage } : {}),
  };
}

interface SiteEventEnvironment {
  readonly document: Pick<Document, "addEventListener" | "removeEventListener"> & {
    readonly getSelection?: () => { readonly anchorNode: Node | null } | null;
  };
  readonly navigator: Pick<Navigator, "sendBeacon"> & { readonly doNotTrack?: string | null };
  readonly location: Pick<Location, "pathname">;
}

/** Sends one event; never throws and never waits. */
export function sendSiteEvent(env: SiteEventEnvironment, endpoint: string, event: SiteEvent): void {
  try {
    if (env.navigator.doNotTrack === "1") return;
    if (typeof env.navigator.sendBeacon !== "function") return;
    const body = new Blob([JSON.stringify(event)], { type: "text/plain" });
    env.navigator.sendBeacon(endpoint, body);
  } catch {
    // Best effort only.
  }
}

function closestMarked(target: EventTarget | null, attr: string): HTMLElement | null {
  const element = target as { closest?: (selector: string) => Element | null } | null;
  if (!element || typeof element.closest !== "function") return null;
  return element.closest(`[${attr}]`) as HTMLElement | null;
}

/**
 * Listens on the document for clicks on download links and copies of the
 * install command. Returns a function that stops listening.
 */
export function startSiteEvents(
  env: SiteEventEnvironment,
  origin: string | undefined | null,
): () => void {
  const endpoint = siteEventsEndpoint(origin);
  // Pointer clicks and keyboard activation both fire `click`. Middle clicks
  // (open in new tab) fire `auxclick`.
  const onClick = (event: Event) => {
    if (event.type === "auxclick" && (event as MouseEvent).button !== 1) return;
    const link = closestMarked(event.target, SITE_EVENT_DOWNLOAD_ATTR);
    if (!link) return;
    const href = link.getAttribute("href");
    // A link to another page of this site (such as /download#linux) is not a download.
    if (href && href.startsWith("/") && !href.startsWith("//")) return;
    const asset = assetForDownloadLink(link.dataset, href);
    sendSiteEvent(env, endpoint, buildSiteEvent("download_click", asset, env.location.pathname));
  };
  const onCopy = (event: Event) => {
    // The copy event targets the selection's element in most browsers; fall
    // back to the selection anchor for the rest.
    let source = closestMarked(event.target, SITE_EVENT_COPY_ATTR);
    if (!source) {
      try {
        const anchor = env.document.getSelection?.()?.anchorNode ?? null;
        source = closestMarked(
          anchor?.nodeType === 1 ? anchor : (anchor?.parentElement ?? null),
          SITE_EVENT_COPY_ATTR,
        );
      } catch {
        source = null;
      }
    }
    if (!source) return;
    const asset = source.getAttribute(SITE_EVENT_COPY_ATTR) || "install.sh";
    sendSiteEvent(env, endpoint, buildSiteEvent("install_copy", asset, env.location.pathname));
  };
  env.document.addEventListener("click", onClick, { capture: true, passive: true });
  env.document.addEventListener("auxclick", onClick, { capture: true, passive: true });
  env.document.addEventListener("copy", onCopy, { capture: true, passive: true });
  return () => {
    env.document.removeEventListener("click", onClick, { capture: true });
    env.document.removeEventListener("auxclick", onClick, { capture: true });
    env.document.removeEventListener("copy", onCopy, { capture: true });
  };
}
