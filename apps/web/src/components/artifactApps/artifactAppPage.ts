import type { HtmlRenderReference } from "@specweave-studio/shared/htmlRender";
import { htmlRenderFromToolItem } from "@specweave-studio/shared/toolOutput";

/** The parts of a thread's turn item this module reads. */
export interface ArtifactAppTurnItem {
  readonly type: string;
  readonly status?: string | undefined;
  readonly toolName?: string | null | undefined;
  readonly output?: unknown;
}

/**
 * The page an installed app shows: the newest completed report page in the
 * thread with the install's title, so a page republished under the same title
 * replaces the old one. When no page carries the title any more (the agent
 * renamed it), the page the person installed, by its attachment id. Visuals
 * are never apps.
 */
export function newestArtifactAppPage(
  turnItems: ReadonlyArray<ArtifactAppTurnItem>,
  input: { readonly title: string; readonly attachmentId: string },
): HtmlRenderReference | null {
  const title = input.title.trim();
  let newest: HtmlRenderReference | null = null;
  let installed: HtmlRenderReference | null = null;
  for (const item of turnItems) {
    if (item.type !== "dynamic_tool" || item.status !== "completed") continue;
    const page = htmlRenderFromToolItem({ toolName: item.toolName, output: item.output });
    if (page === undefined || page.kind === "visual") continue;
    if (page.title.trim() === title) newest = page;
    else if (page.attachmentId === input.attachmentId) installed = page;
  }
  return newest ?? installed;
}

export type ArtifactAppViewState =
  | "loading"
  | "not-installed"
  | "thread-unavailable"
  | "page-missing"
  | "ready";

/**
 * What an installed-page window shows. Loading ends: a machine that is down,
 * a thread that is gone, or a wait past its limit each say so plainly.
 */
export function artifactAppViewState(input: {
  /** `undefined` while the shell answers; `null` when this window has no install. */
  readonly install: { readonly installId: string } | null | undefined;
  /** The install id in the window's route. */
  readonly routeInstallId: string;
  readonly environmentUnreachable: boolean;
  /** The machine's thread list has loaded, so a missing thread is really missing. */
  readonly threadListLoaded: boolean;
  readonly threadListed: boolean;
  readonly threadDeleted: boolean;
  readonly threadStatus: "empty" | "cached" | "synchronizing" | "live" | "deleted";
  readonly pageFound: boolean;
  /** Older history is still being read for the page. */
  readonly olderHistoryPending: boolean;
  /** The window has waited longer than it should for the thread. */
  readonly waitedTooLong: boolean;
}): ArtifactAppViewState {
  if (input.install === undefined) return "loading";
  if (input.install === null || input.install.installId !== input.routeInstallId) {
    return "not-installed";
  }
  if (input.threadDeleted || input.threadStatus === "deleted") return "thread-unavailable";
  if (input.threadListLoaded && !input.threadListed) return "thread-unavailable";
  if (input.pageFound) return "ready";
  if (input.environmentUnreachable) return "thread-unavailable";
  // A cached copy may predate the page; only the live thread can say it is gone.
  if (input.threadStatus === "live" && !input.olderHistoryPending) return "page-missing";
  return input.waitedTooLong ? "thread-unavailable" : "loading";
}
