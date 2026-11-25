import {
  EnvironmentId,
  ThreadId,
  type DesktopArtifactApp,
  type ScopedThreadRef,
} from "@specweave-studio/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@specweave-studio/shared/htmlRender";
import { FolderOpenIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useTx } from "~/i18n";
import { cn, isMacPlatform } from "~/lib/utils";
import { useUnreachableEnvironmentIds } from "~/state/environments";
import {
  useThreadHistory,
  useThreadProjection,
  useThreadShell,
  useThreadStatus,
} from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { environmentShell } from "~/state/shell";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";

import { useHtmlRenderSrc } from "../chat/HtmlRenderFrame";
import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import {
  artifactAppViewState,
  newestArtifactAppPage,
  type ArtifactAppViewState,
} from "./artifactAppPage";

// A thread that never loads (an unknown machine, a stuck connection) stops
// saying "Loading" after this long.
const THREAD_WAIT_LIMIT_MS = 20_000;
// Older history pages read while looking for a page before calling it gone.
const MAX_HISTORY_PAGES = 20;
// The same inset AppSidebarLayout keeps for the macOS window buttons.
const MACOS_WINDOW_BUTTONS_INSET = "var(--desktop-window-controls-inset, 90px)";

/**
 * An installed page's own window. The shell tells the window which install it
 * shows; the route's id only has to agree with it, so a typed or stale URL
 * cannot point the window at another install.
 */
export function ArtifactAppView({ routeInstallId }: { readonly routeInstallId: string }) {
  const [install, setInstall] = useState<DesktopArtifactApp | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const getArtifactApp = window.desktopBridge?.getArtifactApp;
    const pending = typeof getArtifactApp === "function" ? getArtifactApp() : Promise.resolve(null);
    void pending.then(
      (app) => !cancelled && setInstall(app),
      () => !cancelled && setInstall(null),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  const known = install !== undefined && install !== null && install.installId === routeInstallId;
  return known ? (
    <InstalledPageWindow app={install} />
  ) : (
    <ArtifactAppFrame name={null}>
      <ArtifactAppMessage state={install === undefined ? "loading" : "not-installed"} />
    </ArtifactAppFrame>
  );
}

function InstalledPageWindow({ app }: { readonly app: DesktopArtifactApp }) {
  const threadRef = useMemo<ScopedThreadRef>(
    () => ({
      environmentId: EnvironmentId.make(app.environmentId),
      threadId: ThreadId.make(app.threadId),
    }),
    [app.environmentId, app.threadId],
  );
  // Same signals as a thread route: the machine's thread list, then the thread.
  const shell = useEnvironmentQuery(environmentShell.stateAtom(threadRef.environmentId));
  const threadShell = useThreadShell(threadRef);
  // Mounting the projection subscribes the thread, so a republished page arrives live.
  const thread = useThreadProjection(threadRef);
  const threadStatus = useThreadStatus(threadRef);
  const unreachable = useUnreachableEnvironmentIds().has(threadRef.environmentId);
  const turnItems = thread?.projection.turnItems;
  const page = useMemo(
    () =>
      newestArtifactAppPage(turnItems ?? [], {
        title: app.title,
        attachmentId: app.attachmentId,
      }),
    [app.attachmentId, app.title, turnItems],
  );
  const [waitedTooLong, setWaitedTooLong] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setWaitedTooLong(true), THREAD_WAIT_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, []);
  // The thread arrives as its newest window; a page published long ago may sit
  // in older history, so page back (a bounded number of times) before calling it gone.
  const history = useThreadHistory(threadRef);
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const [historyPages, setHistoryPages] = useState(0);
  const canPageBack =
    page === null &&
    threadStatus === "live" &&
    history.hasMoreHistory &&
    history.error === null &&
    historyPages < MAX_HISTORY_PAGES;
  useEffect(() => {
    if (!canPageBack || history.loading) return;
    // Counted when the read settles: the history's own loading flag holds off a second read.
    void loadEarlier({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }).finally(() => setHistoryPages((pages) => pages + 1));
  }, [canPageBack, history.loading, loadEarlier, threadRef]);
  const state = artifactAppViewState({
    install: app,
    routeInstallId: app.installId,
    environmentUnreachable: unreachable,
    threadListLoaded: shell.data?.snapshot._tag === "Some",
    threadListed: threadShell !== null,
    threadDeleted: threadShell?.deletedAt != null,
    threadStatus,
    pageFound: page !== null,
    olderHistoryPending: canPageBack || (page === null && history.loading),
    waitedTooLong,
  });
  return (
    <ArtifactAppFrame name={app.name} installId={app.installId}>
      {state === "ready" && page !== null ? (
        // Keyed by attachment: a newer page with the title mints its own URL and frame.
        <InstalledPage
          key={page.attachmentId}
          environmentId={threadRef.environmentId}
          page={page}
          name={app.name}
          unreachable={unreachable || waitedTooLong}
        />
      ) : (
        <ArtifactAppMessage state={state} />
      )}
    </ArtifactAppFrame>
  );
}

/**
 * The page in the same sandboxed frame the thread uses, never loaded top
 * level, so it is never same-origin with the app. The frame takes the page's
 * height, at least the window's, and the window scrolls.
 */
function InstalledPage(props: {
  readonly environmentId: EnvironmentId;
  readonly page: HtmlRenderReference;
  readonly name: string;
  /** The machine is down or never answered, so a page not yet loaded cannot load. */
  readonly unreachable: boolean;
}) {
  const tx = useTx();
  const { attachmentId, title } = props.page;
  const { src, failed } = useHtmlRenderSrc(props.environmentId, attachmentId, title);
  if (src !== null) return <InstalledPageDocument src={src} page={props.page} name={props.name} />;
  // A cached page whose machine is away cannot mint its URL; say so rather than load forever.
  if (props.unreachable) return <ArtifactAppMessage state="thread-unavailable" />;
  return (
    <Empty className="min-h-0 flex-1" role="status">
      <EmptyHeader>
        <EmptyTitle>
          {failed ? tx("Unable to load {name}", { name: props.name }) : tx("Loading…")}
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

function InstalledPageDocument(props: {
  readonly src: string;
  readonly page: HtmlRenderReference;
  readonly name: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: HTML_RENDER_COLUMN_WIDTH, height: 0 });
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const measure = () => {
      if (scroller.clientWidth > 0) {
        setViewport({ width: scroller.clientWidth, height: scroller.clientHeight });
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  const [contentHeight, setContentHeight] = useState<number>();
  const height = Math.max(
    viewport.height,
    Math.min(
      50_000,
      contentHeight ?? htmlRenderFrameHeight(props.page, viewport.width, contentHeight),
    ),
  );
  return (
    <div ref={scrollerRef} className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <div className="w-full" style={{ height }}>
        <HtmlRenderDocument
          src={props.src}
          title={props.name}
          className="block size-full"
          onContentHeight={setContentHeight}
        />
      </div>
    </div>
  );
}

/** The window's chrome: a draggable strip with the app's name and its two actions. */
function ArtifactAppFrame(props: {
  readonly name: string | null;
  readonly installId?: string;
  readonly children: ReactNode;
}) {
  const tx = useTx();
  const { name, installId } = props;
  useEffect(() => {
    if (name !== null) document.title = name;
  }, [name]);
  const [busy, setBusy] = useState(false);
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const reveal = bridge?.revealArtifactApp;
  const uninstall = bridge?.uninstallArtifactApp;
  const onReveal = async () => {
    if (installId === undefined || typeof reveal !== "function") return;
    const shown = await reveal({ installId }).catch(() => false);
    if (!shown) {
      toastManager.add({ type: "error", title: tx("Could not show the app in its folder") });
    }
  };
  const onUninstall = async () => {
    if (installId === undefined || typeof uninstall !== "function" || busy) return;
    setBusy(true);
    const removed = await uninstall({ installId }).catch(() => false);
    if (removed) {
      // The install is gone; this window has nothing left to show.
      window.close();
      return;
    }
    setBusy(false);
    toastManager.add({ type: "error", title: tx("Could not uninstall the app") });
  };
  const macosDesktop =
    isElectron && typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
  return (
    <div className="flex h-svh min-h-0 flex-col bg-background text-foreground">
      <header
        className={cn(
          "flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center gap-3 border-b border-border px-3 wco:pr-(--workspace-native-controls-inset)",
          isElectron && "drag-region",
        )}
        // Clear of the macOS window buttons, as the main window's title row is.
        style={macosDesktop ? { paddingLeft: MACOS_WINDOW_BUTTONS_INSET } : undefined}
      >
        <h1 className="min-w-0 flex-1 truncate text-compact font-semibold">
          {name ?? tx("Installed page")}
        </h1>
        {installId !== undefined && typeof reveal === "function" ? (
          <Button variant="ghost" size="sm" onClick={() => void onReveal()}>
            <FolderOpenIcon aria-hidden className="size-4" /> {tx("Show in folder")}
          </Button>
        ) : null}
        {installId !== undefined && typeof uninstall === "function" ? (
          <Button variant="ghost" size="sm" onClick={() => void onUninstall()} disabled={busy}>
            <Trash2Icon aria-hidden className="size-4" /> {tx("Uninstall")}
          </Button>
        ) : null}
      </header>
      {props.children}
    </div>
  );
}

function ArtifactAppMessage({ state }: { readonly state: ArtifactAppViewState }) {
  const tx = useTx();
  const copy =
    state === "not-installed"
      ? {
          title: tx("This app is not installed"),
          description: tx("Install it again from the report in its thread."),
        }
      : state === "thread-unavailable"
        ? {
            title: tx("This page's thread is not available"),
            description: tx(
              "Its machine may be offline, or the thread was deleted. Open SpecWithCode to check.",
            ),
          }
        : state === "page-missing"
          ? {
              title: tx("This page is no longer in its thread"),
              description: tx("Ask the agent to publish it again under the same title."),
            }
          : { title: tx("Loading…"), description: null };
  return (
    <Empty className="min-h-0 flex-1" role={state === "loading" ? "status" : undefined}>
      <EmptyHeader>
        <EmptyTitle>{copy.title}</EmptyTitle>
        {copy.description ? <EmptyDescription>{copy.description}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
