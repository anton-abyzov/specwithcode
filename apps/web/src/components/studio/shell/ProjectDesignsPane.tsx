/**
 * The project's Designs tab: every design the project owns
 * (`.specweave/design/`), as thumbnails, newest first. New design opens the
 * gallery's dialog with this project preselected; a card opens the editor; a
 * bound thread opens in this panel. The gallery lists this machine's projects
 * only, so a project on another machine offers its designs without it.
 */
import {
  AuthFilesystemWriteScope,
  type DesignSummary,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  MessagesSquareIcon,
  PaletteIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import { useState, type MouseEvent } from "react";

import { usePrimaryEnvironmentId } from "../../../state/environments";
import { useEnvironmentScope } from "../../../state/session";
import { problemKey } from "../../design/gallery/boardOwner";
import { designPath } from "../../design/gallery/designLinks";
import { NearViewport } from "../../design/gallery/DesignThumbnail";
import { editedAgo, gallerySearchFor } from "../../design/gallery/galleryModel";
import { LibraryDesignMenu } from "../../design/gallery/LibraryDesignMenu";
import { LiveThumbnail } from "../../design/gallery/LiveThumbnail";
import type { ProjectDesigns } from "../../design/useProjectDesigns";
import { LibraryFileViewer, type LibraryViewerFile } from "./LibraryFileViewer";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";
import { Tip } from "./Tip";
import { designFile, useProjectDesignActions } from "./useProjectDesignActions";

/** The pane shows this many; the gallery shows the rest. */
export const PROJECT_DESIGNS_SHOWN = 12;

export function pagesLabel(summary: Pick<DesignSummary, "kind" | "pageCount">): string {
  const noun = summary.kind === "slides" ? "slide" : "page";
  return `${summary.pageCount} ${noun}${summary.pageCount === 1 ? "" : "s"}`;
}

/** A plain click navigates in the app; a modified click keeps the browser's own behavior. */
const inApp = (event: MouseEvent, go: () => void) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
    return;
  event.preventDefault();
  go();
};

/** The project header's way in: shown once the project owns a design. */
export function ProjectDesignsButton({
  designs,
  pressed,
  onClick,
}: {
  designs: Pick<ProjectDesigns, "loaded" | "count">;
  pressed: boolean;
  onClick: () => void;
}) {
  if (!designs.loaded || designs.count === 0) return null;
  const noun = designs.count === 1 ? "design" : "designs";
  return (
    <Tip label={`Open this project's ${noun}`}>
      <button
        type="button"
        className="project-control sws-top-button sws-overview-toggle"
        aria-label={`Designs, ${designs.count} ${noun}`}
        aria-pressed={pressed}
        data-testid="project-designs-button"
        onClick={onClick}
      >
        <PaletteIcon aria-hidden />
        <span>Designs</span>
        <span className="sws-count" aria-hidden>
          {designs.count}
        </span>
      </button>
    </Tip>
  );
}

export function ProjectDesignsPane({
  environmentId,
  projectId,
  projectTitle,
  workspaceRoot,
  designs,
  threadTitle,
  onOpenThread,
  bar,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectTitle: string;
  workspaceRoot: string;
  designs: ProjectDesigns;
  /** The bound thread's title, when this project lists it. */
  threadTitle: (threadId: ThreadId) => string | null;
  onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  bar: ProjectPaneBarProps;
}) {
  const router = useRouter();
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const inGallery = usePrimaryEnvironmentId() === environmentId;
  const { openDesign, copyToPlayground } = useProjectDesignActions(environmentId, projectId);
  const [opened, setOpened] = useState<LibraryViewerFile | null>(null);
  // Without the gallery to show the rest, a project on another machine lists every design.
  const shown = inGallery ? designs.designs.slice(0, PROJECT_DESIGNS_SHOWN) : designs.designs;
  const hidden = designs.count - shown.length;
  const galleryHref = `/design?project=${encodeURIComponent(projectId)}`;
  const openGallery = () =>
    void router.navigate({
      to: "/design",
      search: gallerySearchFor({ tab: "projects", projectId }),
    });
  const newDesign = () =>
    void router.navigate({ to: "/design", search: { new: "design", owner: projectId } });

  const tools = (
    <Tip label="Reload designs">
      <button
        type="button"
        className="sws-icon-button"
        aria-label="Reload designs"
        onClick={designs.refresh}
      >
        <RotateCwIcon aria-hidden />
      </button>
    </Tip>
  );

  return (
    <>
      <ProjectPaneBar {...bar} tools={tools} />
      <div
        className="sws-threads-body @container"
        id="sws-pane-designs"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-designs"
        data-testid="project-designs"
      >
        {inGallery ? (
          <div className="flex items-center gap-2 px-1 pt-1 pb-3">
            <button
              type="button"
              className="project-control project-primary inline-flex items-center gap-1.5"
              disabled={!canWrite}
              onClick={newDesign}
            >
              <PlusIcon aria-hidden className="size-3.5" />
              New design
            </button>
            <span className="flex-1" />
            <a
              href={galleryHref}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12.5px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={(event) => inApp(event, openGallery)}
            >
              Open in Designs
              <ArrowUpRightIcon aria-hidden className="size-3.5" />
            </a>
          </div>
        ) : (
          <p className="px-1 pt-1 pb-3 text-xs text-pretty text-muted-foreground">
            {projectTitle} is on another machine. Its designs open here; make new ones in the app on
            that machine.
          </p>
        )}
        {designs.problems.length > 0 ? (
          <ul className="flex flex-col gap-0.5 px-1 pb-3" role="status">
            {designs.problems.map((problem) => (
              <li
                key={problemKey(problem)}
                className="text-xs text-muted-foreground"
              >
                {problem.ownerLabel}: {problem.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {designs.error !== null && designs.count === 0 ? (
          <p className="project-notice" role="alert">
            {designs.error}
          </p>
        ) : null}
        {!designs.loaded ? (
          <ul
            className="grid grid-cols-1 gap-x-3 gap-y-5 px-1 @min-[360px]:grid-cols-2"
            aria-label="Loading designs"
            aria-busy="true"
          >
            {[0, 1].map((index) => (
              <li key={index} className="flex flex-col gap-2" aria-hidden>
                <span className="block aspect-[4/3] rounded-lg bg-muted/60" />
                <span className="block h-3 w-2/3 rounded bg-muted/70" />
                <span className="block h-2.5 w-1/3 rounded bg-muted/50" />
              </li>
            ))}
          </ul>
        ) : designs.count === 0 ? (
          <div
            className="mx-1 flex flex-col items-start gap-3 rounded-lg border border-dashed border-border px-4 py-5"
            data-testid="project-designs-empty"
          >
            <p className="text-[13px] text-pretty text-muted-foreground">
              Designs you or an agent make for {projectTitle} live here.
            </p>
            {inGallery ? (
              <button
                type="button"
                className="project-control inline-flex items-center gap-1.5"
                disabled={!canWrite}
                onClick={newDesign}
              >
                <PlusIcon aria-hidden className="size-3.5" />
                New design
              </button>
            ) : null}
          </div>
        ) : (
          <ul
            className="grid grid-cols-1 gap-x-3 gap-y-5 px-1 @min-[360px]:grid-cols-2"
            aria-label={`${projectTitle} designs`}
          >
            {shown.map((summary) => {
              const title = summary.title || "Untitled";
              const href = designPath({ kind: "project", projectId }, summary.ref.designId);
              const thread = summary.thread;
              const boundTitle = thread ? threadTitle(thread.threadId) : null;
              return (
                <li key={summary.ref.designId}>
                  <article className="flex flex-col gap-2" data-testid="project-design-card">
                    <a
                      href={href}
                      aria-label={`Open ${title}`}
                      className="block aspect-[4/3] overflow-hidden rounded-lg bg-muted/60 ring-1 ring-border/60 outline-none transition-[box-shadow,background-color] duration-150 ease-out hover:bg-muted hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(event) => inApp(event, () => openDesign(summary))}
                    >
                      <NearViewport className="h-full w-full">
                        <LiveThumbnail environmentId={environmentId} summary={summary} />
                      </NearViewport>
                    </a>
                    <div className="flex items-start gap-1 px-0.5">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <Tip label={title} side="top">
                          <h3 className="truncate text-[13px] leading-5 font-medium">{title}</h3>
                        </Tip>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {editedAgo(summary.updatedAt, Date.now())} · {pagesLabel(summary)}
                        </p>
                        {thread ? (
                          <button
                            type="button"
                            className="mt-1 inline-flex max-w-full items-center gap-1 self-start rounded-full bg-foreground/5 px-2 py-0.5 text-xs font-medium text-foreground/80 transition-colors duration-150 hover:bg-foreground/10"
                            onClick={() => onOpenThread(thread.threadId, thread.environmentId)}
                          >
                            <MessagesSquareIcon aria-hidden className="size-3 shrink-0" />
                            <span className="truncate">{boundTitle ?? "Design thread"}</span>
                          </button>
                        ) : null}
                      </div>
                      <LibraryDesignMenu
                        title={title}
                        // A copy lands in that machine's Playground, which this gallery cannot open.
                        canCopy={canWrite && inGallery}
                        onOpen={() => openDesign(summary)}
                        onCopyToPlayground={() => void copyToPlayground(summary)}
                        onShowFile={() => setOpened(designFile(summary))}
                      />
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
        {hidden > 0 && inGallery ? (
          <a
            href={galleryHref}
            className="sws-show-more mt-4 inline-flex"
            onClick={(event) => inApp(event, openGallery)}
          >
            Show all {designs.count} in Designs
          </a>
        ) : null}
      </div>
      {opened ? (
        <LibraryFileViewer
          environmentId={environmentId}
          workspaceRoot={workspaceRoot}
          files={[opened]}
          path={opened.path}
          onPath={(path) => setOpened({ path, name: path })}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </>
  );
}
