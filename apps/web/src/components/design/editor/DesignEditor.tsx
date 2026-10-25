import { useRouter } from "@tanstack/react-router";
import type {
  DesignComment,
  DesignNode,
  DesignOperation,
  DesignSystemComponent,
  DesignThreadBinding,
} from "@specweave-studio/contracts";
import {
  designAccess,
  designBoundThread,
  designCommentThreads,
} from "@specweave-studio/shared/designOps";
import {
  type DesignRenderContext,
  designRenderMode,
  detachDesignTokens,
} from "@specweave-studio/shared/designRender";
import {
  CodeIcon,
  DownloadIcon,
  HistoryIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightIcon,
  PlayIcon,
  PresentationIcon,
  Redo2Icon,
  Share2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { CameraStore } from "../canvas/camera";
import { DesignCanvas, zoomToContent } from "../canvas/DesignCanvas";
import { indexNodes, pageRect, type Point } from "../canvas/geometry";
import { DesignRenderContextValue } from "../canvas/NodeView";
import { PresentMode, presentationFrames } from "../canvas/PresentMode";
import { createComponentNode, createImageNode, type CanvasTool } from "../canvas/tools";
import {
  downloadExport,
  cropExportImage,
  exportAsImage,
  imageSize,
  readFileBase64,
  useDesignSession,
  type DesignUnsavedOutcome,
  type DesignEditorBackend,
  type DesignEditorData,
  type DesignExportRequest,
  type DesignMessage,
} from "./backend";
import { encodeSystemKey } from "../designKey";
import { EditorMoreMenu, type EditorPlace } from "./EditorMoreMenu";
import { EditorSystemPicker, useEditorSystem } from "./EditorSystemPicker";
import { systemChangeOperations } from "./editorSystem";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { editorLayout } from "./editorLayout";
import { useHeaderLayout } from "./useHeaderLayout";
import { BoundThreadPane, threadNotice } from "./BoundThreadPane";
import { CommentsPanel, type CommentDraft } from "./CommentsPanel";
import { ComponentPicker } from "./ComponentPicker";
import { PageMenu, ToolRail, ZoomMenu } from "./DesignToolbar";
import {
  containingArtboard,
  selectionCrop,
  selectionMessage,
  sendFrameHandoff,
  type ImplementTarget,
} from "./handoff";
import { ImplementFrameDialog } from "./ImplementFrameDialog";
import { MiniToolbar } from "./MiniToolbar";
import { PropertiesPanel } from "./PropertiesPanel";
import { ReuseChip } from "./ReuseChip";
import { ShareDialog } from "./ShareDialog";
import { OwnerCrumbs, SaveState, TitleField } from "./EditorTitleBar";
import { ownerLinks } from "./ownerLinks";
import { applySlideLayout } from "@specweave-studio/shared/slideLayouts";
import { isEmptySlide, setSlideNotes } from "../slides/slideActions";
import { SlideRail } from "../slides/SlideRail";
import { SlideLayoutPrompt } from "../slides/SlideLayoutPrompt";
import { SpeakerNotes } from "../slides/SpeakerNotes";

const CHAT_WIDTH_KEY = "specwithcode.design.chatWidth";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export interface DesignEditorProps {
  readonly backend: DesignEditorBackend;
  readonly data: DesignEditorData;
  readonly designKey: string;
  /** The bound thread's chat, rendered by the route (the app's ChatView). */
  readonly renderChat: (binding: DesignThreadBinding) => ReactNode;
}

/**
 * The design editor: the bound agent thread on the left, the canvas on the
 * right, with tools, pages, properties, comments, export, present and share.
 */
export function DesignEditor({ backend, data, designKey, renderChat }: DesignEditorProps) {
  const router = useRouter();
  // The toast fires after the editor closed: name the design as it was last shown, not as it opened.
  const titleRef = useRef(data.initial.title);
  const onUnsaved = useCallback(
    (outcome: DesignUnsavedOutcome) => {
      const title = titleRef.current;
      toastManager.add({
        type: "error",
        title:
          outcome.kind === "conflict"
            ? `Your last changes to ${title || "the design"} were not saved`
            : `${title || "The design"} did not finish saving`,
        description:
          outcome.kind === "conflict"
            ? "The agent changed the same layers. Open the design to keep yours or take theirs."
            : outcome.detail,
        timeout: 0,
        actionProps: {
          children: "Open design",
          onClick: () => void router.navigate({ to: "/design/$designKey", params: { designKey } }),
        },
      });
    },
    [designKey, router],
  );
  const { session, snapshot } = useDesignSession(
    `${backend.environmentId}:${designKey}`,
    data.initial,
    backend.transport,
    data.live,
    onUnsaved,
  );
  const document = snapshot.document;
  useEffect(() => {
    titleRef.current = document.title;
  }, [document.title]);
  const [pageId, setPageId] = useState(document.pages[0]!.id);
  const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0]!;
  const [tool, setTool] = useState<CanvasTool>("select");
  const [selection, setSelection] = useState<readonly string[]>([]);
  const [camera] = useState(() => new CameraStore());
  const [canvasOnly, setCanvasOnly] = useState(false);
  const [chatWidth, setChatWidth] = useState(() => readChatWidth());
  const [side, setSide] = useState<"properties" | "comments" | "history">("properties");
  // Narrow windows: the thread and the side panel open over the canvas instead of beside it.
  const [chatOverlayOpen, setChatOverlayOpen] = useState(false);
  const [sideOverlayOpen, setSideOverlayOpen] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const [bodyWidth, setBodyWidth] = useState(0);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<string | null | false>(false);
  const [presenterView, setPresenterView] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [implementFrame, setImplementFrame] = useState<DesignNode | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageAt = useRef<Point>({ x: 0, y: 0 });
  const { resolvedTheme } = useTheme();
  const binding = designBoundThread(document);
  const slides = document.kind === "slides";
  const access = designAccess(document);
  // The owner on this machine can always edit; members get the level the owner set (the server enforces it too).
  const level = backend.audience === "owner" ? "edit" : access.members;
  const readOnly = level !== "edit";
  const canComment = level !== "view";
  // One pin per thread: replies sit with their first comment.
  const threadRoots = useMemo(
    () => designCommentThreads(document.comments).map((thread) => thread.root),
    [document.comments],
  );
  // Slides render in the deck's mode, not the viewer's theme.
  const mode = useMemo(
    () => designRenderMode(document.kind, data.system, resolvedTheme),
    [data.system, document.kind, resolvedTheme],
  );
  const renderContext = useMemo<DesignRenderContext>(
    () => ({ system: data.system, mode, assetUrl: data.assetUrl }),
    [data.assetUrl, data.system, mode],
  );
  const index = useMemo(() => indexNodes(page), [page]);
  const selectedNodes = useMemo(
    () => selection.map((id) => index.get(id)).filter((node) => node !== undefined),
    [index, selection],
  );

  // Measured before paint, so the first zoom to fit sees the final canvas size.
  useLayoutEffect(() => {
    const element = body.current;
    if (element === null) return;
    const measure = () => setBodyWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const layout = editorLayout({
    width: bodyWidth > 0 ? bodyWidth : Number.POSITIVE_INFINITY,
    chatWidth,
    chatOpen: !canvasOnly,
    slides,
  });
  const sideVisible = layout.side === "column" || sideOverlayOpen;
  const [headerRef, header] = useHeaderLayout();
  const undo = () => {
    const r = session.undo();
    if (!r.ok) reportError(r.detail);
  };
  const redo = () => {
    const r = session.redo();
    if (!r.ok) reportError(r.detail);
  };
  /** A header tool that moves into More on a narrow header. */
  const headerTool = header.tools ? "" : "hidden";
  const showSide = (next: "properties" | "comments" | "history") => {
    setSide(next);
    setSideOverlayOpen(true);
  };

  // First view: fit the page once the canvas has a size.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    fitted.current = true;
    const frame = requestAnimationFrame(() => zoomToContent(camera, page, []));
    return () => cancelAnimationFrame(frame);
  }, [camera, page]);

  useEffect(() => {
    if (!document.pages.some((candidate) => candidate.id === pageId))
      setPageId(document.pages[0]!.id);
  }, [document.pages, pageId]);

  const reportError = useCallback((detail: string) => {
    toastManager.add({ type: "error", title: "That change did not apply", description: detail });
  }, []);

  const commit = useCallback(
    (operations: readonly DesignOperation[]) => {
      if (operations.length === 0) return true;
      const result = session.commit(operations);
      if (!result.ok) reportError(result.detail);
      return result.ok;
    },
    [reportError, session],
  );

  const systemControl = useEditorSystem({
    owner: backend.address.owner,
    systems: backend.designSystems.systems,
    projects: backend.designSystems.projects,
    value: document.designSystem,
    reuse: document.reuse ?? null,
    // With no system, token layers keep the values they show now instead of turning transparent.
    onChange: (systemId) =>
      commit([
        ...(systemId === null ? detachDesignTokens(document, renderContext) : []),
        ...systemChangeOperations(systemId, document.reuse ?? null),
      ]),
    onCopy: backend.designSystems.copy,
    onOpen: ({ owner, systemId }) =>
      void router.navigate({
        to: "/design/systems/$systemKey",
        params: { systemKey: encodeSystemKey(owner, systemId) },
      }),
    onManage: () => void router.navigate({ to: "/settings/design-systems" }),
    disabled: readOnly,
  });
  const versions = backend.versions ?? null;
  const toggleSide = (next: "comments" | "history") => {
    if (layout.side === "overlay")
      return sideOverlayOpen && side === next ? setSideOverlayOpen(false) : showSide(next);
    setSide(side === next ? "properties" : next);
  };
  /** Saves what is pending, then puts `revision` back as the newest revision. */
  const restoreVersion = async (revision: number) => {
    if (versions === null) return;
    // A save still on the wire would land on top of the restore, or be rebased onto it.
    if (!(await session.settle())) {
      reportError("Some edits are not saved yet. Resolve them, then restore the version.");
      return;
    }
    session.receive(await versions.restore(revision, session.getSnapshot().base.revision));
  };

  const changePage = (next: string) => {
    setPageId(next);
    setSelection([]);
    const target = document.pages.find((candidate) => candidate.id === next);
    if (target !== undefined) requestAnimationFrame(() => zoomToContent(camera, target, []));
  };

  // ---- images ---------------------------------------------------------------
  const addImages = async (files: readonly File[], at: Point) => {
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) {
        reportError(`${file.name} is not a PNG, JPEG, GIF, WebP or SVG image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        reportError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      try {
        const [base64, natural] = await Promise.all([readFileBase64(file), imageSize(file)]);
        const asset = await backend.assetPut(file.type, base64);
        const { operation, node } = createImageNode({ page, index }, asset, natural, at, file.name);
        if (commit([operation])) setSelection([node.id]);
      } catch (cause) {
        reportError(
          `Could not upload ${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    setTool("select");
  };
  /** The page point at the centre of the canvas viewport. */
  const viewCenter = (): Point => {
    const size = camera.viewportSize();
    const view = camera.get();
    return { x: (size.width / 2 - view.x) / view.zoom, y: (size.height / 2 - view.y) / view.zoom };
  };
  const pickImage = (at?: Point) => {
    imageAt.current = at ?? viewCenter();
    imageInput.current?.click();
  };

  // ---- components -----------------------------------------------------------
  /** Into the middle of the selected frame, else the middle of the view. */
  const insertComponent = (component: DesignSystemComponent) => {
    const frame = selectedNodes.find((node) => node.type === "frame");
    let at = viewCenter();
    if (frame !== undefined) {
      const rect = pageRect(index, frame);
      at = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }
    const { operation, node } = createComponentNode({ page, index }, component, at);
    if (!commit([operation])) return;
    setSelection([node.id]);
    setTool("select");
  };

  // ---- export -------------------------------------------------------------------
  // Every export renders in the canvas mode, so files and agent images match the canvas.
  const exportFile = (request: DesignExportRequest) => backend.exportFile({ ...request, mode });
  const runExport = async (request: DesignExportRequest) => {
    const toastId = toastManager.add({ type: "loading", title: "Exporting..." });
    try {
      const result = await exportFile(request);
      downloadExport(result);
      toastManager.update(toastId, { type: "success", title: `Exported ${result.fileName}` });
    } catch (cause) {
      toastManager.update(toastId, {
        type: "error",
        title: "Export failed",
        description: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };
  const targetFrame = (): DesignNode | null => {
    for (const id of selection) {
      const frame = containingArtboard(page, id);
      if (frame !== null) return frame;
    }
    return page.nodes.find((node) => node.type === "frame" && node.parentId === null) ?? null;
  };
  const exportItems = (frame: DesignNode | null) => (
    <>
      <MenuItem
        disabled={frame === null}
        onClick={() =>
          frame !== null &&
          void runExport({ pageId: page.id, frameId: frame.id, format: "png", scale: 1 })
        }
      >
        PNG{frame === null ? "" : ` of ${frame.name ?? "frame"}`}
      </MenuItem>
      <MenuItem
        disabled={frame === null}
        onClick={() =>
          frame !== null &&
          void runExport({ pageId: page.id, frameId: frame.id, format: "png", scale: 2 })
        }
      >
        PNG at 2x
      </MenuItem>
      {backend.svgExport === true && (
        <MenuItem
          disabled={frame === null}
          onClick={() =>
            frame !== null && void runExport({ pageId: page.id, frameId: frame.id, format: "svg" })
          }
        >
          SVG
        </MenuItem>
      )}
      <MenuItem
        disabled={frame === null}
        onClick={() =>
          frame !== null && void runExport({ pageId: page.id, frameId: frame.id, format: "html" })
        }
      >
        Standalone HTML
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => void runExport({ pageId: page.id, format: "pdf" })}>
        {slides ? "PDF of all slides" : "PDF of all frames"}
      </MenuItem>
      {slides && (
        <MenuItem onClick={() => void runExport({ pageId: page.id, format: "pptx" })}>
          PowerPoint of all slides
        </MenuItem>
      )}
      {frame !== null && backend.startCodingThread !== null && (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => setImplementFrame(frame)}>Implement this frame</MenuItem>
        </>
      )}
    </>
  );
  const [frameMenu, setFrameMenu] = useState<{ frame: DesignNode; anchor: HTMLElement } | null>(
    null,
  );

  // ---- threads ---------------------------------------------------------------------
  const frameImage = async (frame: DesignNode | null) => {
    if (frame === null) return [];
    const result = await exportFile({
      pageId: page.id,
      frameId: frame.id,
      format: "png",
      scale: 1,
    });
    return [exportAsImage(result, `${(frame.name ?? "frame").replace(/[^\w.-]+/g, "-")}.png`)];
  };
  // A thread this window started whose binding the server refused: the agent binds it itself.
  const [selfBinding, setSelfBinding] = useState<{
    readonly thread: DesignThreadBinding;
    readonly reason: string;
  } | null>(null);
  const shownBinding =
    binding ?? (selfBinding !== null && document.thread === undefined ? selfBinding.thread : null);
  /**
   * Starts the design's thread: binds it first, in a write of its own, so the
   * agent's first edit never races the binding and a refusal never holds back
   * canvas edits. When this window may not bind it, the thread still starts
   * and binds itself (an agent may always bind its own thread).
   */
  const startBoundThread = async (first: DesignMessage | null) => {
    const thread = { environmentId: backend.environmentId, threadId: backend.newThreadId() };
    const previous = document.thread ?? null;
    const bound = await session.applyAlone([{ op: "set_thread", thread }]);
    try {
      await backend.startThread(first, { threadId: thread.threadId, selfBind: !bound.ok });
    } catch (cause) {
      // No thread to point at: put the earlier binding back.
      if (bound.ok) void session.applyAlone([{ op: "set_thread", thread: previous }]);
      throw cause;
    }
    setSelfBinding(bound.ok ? null : { thread, reason: bound.detail });
    return thread;
  };
  const startThread = async () => {
    await startBoundThread(null);
  };
  /** A PNG of exactly the selection (AC-06), also for layers outside any frame. */
  const selectionImage = async (ids: readonly string[]) => {
    const crop = selectionCrop(page, ids);
    if (crop === null) return [];
    const result = await exportFile({
      pageId: page.id,
      ...(crop.frameId === undefined ? {} : { frameId: crop.frameId }),
      format: "png",
      scale: 1,
    });
    return [await cropExportImage(result, crop.rect, "selection.png")];
  };
  const askAgent = async (request: string) => {
    const message = {
      text: selectionMessage({ document, page, ids: selection, designKey, request }),
      images: await selectionImage(selection),
    };
    if (binding === null && selfBinding === null) {
      await startBoundThread(message);
    } else if (binding === null && selfBinding !== null) {
      await backend.sendToThread(selfBinding.thread, message);
    } else if (binding !== null && binding.environmentId !== backend.environmentId) {
      throw new Error(
        `The design's thread runs on ${backend.machine(binding.environmentId)?.label ?? "another machine"}. Start a thread here first.`,
      );
    } else if (binding !== null) await backend.sendToThread(binding, message);
    toastManager.add({ type: "success", title: "Sent to the design's thread" });
  };
  const sendImplementation = async (target: ImplementTarget) => {
    const frame = implementFrame;
    if (frame === null) return;
    const sent = await sendFrameHandoff(
      {
        settle: () => session.settle(),
        saved: () => {
          const snapshot = session.getSnapshot();
          return { document: snapshot.base, saveState: snapshot.saveState };
        },
        render: frameImage,
        startCodingThread: backend.startCodingThread,
        sendToThread: backend.sendToThread,
      },
      { pageId: page.id, frameId: frame.id, system: data.system, mode, designKey, target },
    );
    const noPng =
      sent.pngProblem === null
        ? ""
        : `No PNG went with it: the frame could not be rendered${sent.pngProblem === "" ? "" : ` (${sent.pngProblem})`}.`;
    const open = { children: "Open thread", onClick: () => backend.openThread(sent.thread) };
    toastManager.add(
      sent.waiting
        ? {
            type: sent.pngProblem === null ? "info" : "warning",
            title: `Created a coding thread for ${sent.frameName}`,
            description: [
              "No provider is ready, so the handoff waits in its composer and no turn has started. Sign in to one in Settings > Providers, then press Send.",
              noPng,
            ]
              .filter((line) => line !== "")
              .join(" "),
            actionProps: open,
          }
        : {
            type: sent.pngProblem === null ? "success" : "warning",
            title: `Sent ${sent.frameName} to a coding thread`,
            ...(noPng === "" ? {} : { description: noPng }),
            actionProps: open,
          },
    );
  };

  // ---- comments --------------------------------------------------------------------
  const placeComment = (anchor: { nodeId: string | null; x: number; y: number }) => {
    if (!canComment) return;
    const node = anchor.nodeId === null ? undefined : index.get(anchor.nodeId);
    const origin = node === undefined ? { x: 0, y: 0 } : pageRect(index, node);
    setCommentDraft({
      pageId: page.id,
      ...anchor,
      canvasX: Math.round(origin.x + anchor.x),
      canvasY: Math.round(origin.y + anchor.y),
    });
    showSide("comments");
    setTool("select");
  };
  const openComment = (comment: DesignComment) => {
    setActiveComment(comment.id);
    showSide("comments");
    if (comment.pageId !== page.id) setPageId(comment.pageId);
    if (comment.nodeId !== null) setSelection([comment.nodeId]);
  };

  const presentStart = (presenter = false) => {
    const frames = presentationFrames(document);
    const selectedFrame = targetFrame();
    setPresenterView(presenter);
    setPresenting(selectedFrame?.id ?? frames[0]?.frame.id ?? null);
  };

  const connect = backend.connectToProject
    ? () =>
        // Save what is pending first, so the move carries every edit.
        void session
          .flush()
          .then(() => backend.connectToProject?.(() => session.getSnapshot().base))
    : null;
  // The breadcrumb's links, for More while the header hides it.
  const owner = backend.share.ownerProject ?? null;
  const links = ownerLinks(backend.share);
  const project = links.project;
  const places: EditorPlace[] = [
    ...(owner !== null && project !== null
      ? [
          {
            kind: "project" as const,
            label: owner.label,
            go: () => void router.navigate(project.route),
          },
        ]
      : []),
    {
      kind: "designs",
      label: owner === null ? "Playground designs" : `Designs in ${owner.label}`,
      go: () => void router.navigate(links.designs.route),
    },
  ];

  const accessory =
    selectedNodes.length > 0 ? (
      <MiniToolbar
        nodes={selectedNodes}
        system={data.system}
        mode={mode}
        canEdit={!readOnly}
        canComment={canComment}
        canAskAgent={!readOnly}
        onFill={(fill) =>
          commit(
            selectedNodes.map((node) => ({
              op: "update_node" as const,
              pageId: page.id,
              id: node.id,
              patch: { fill },
            })),
          )
        }
        onComment={() => {
          const node = selectedNodes[0]!;
          placeComment({ nodeId: node.id, x: Math.min(16, node.width), y: 0 });
        }}
        onAskAgent={askAgent}
      />
    ) : null;

  return (
    <DesignRenderContextValue value={renderContext}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
        data-testid="design-editor"
      >
        {/* Header tooltips open after 400 ms, then instantly between neighbours. */}
        <TooltipProvider delay={400}>
          <WorkspacePageHeader
            ref={headerRef}
            electron={isElectron}
            className="gap-1 border-b border-border/70"
          >
            {layout.chat === "overlay" ? (
              <HeaderButton
                label={chatOverlayOpen ? "Hide thread" : "Show thread"}
                pressed={chatOverlayOpen}
                onClick={() => setChatOverlayOpen(!chatOverlayOpen)}
              >
                {chatOverlayOpen ? <PanelLeftCloseIcon /> : <PanelLeftOpenIcon />}
              </HeaderButton>
            ) : (
              <HeaderButton
                label={canvasOnly ? "Show thread" : "Canvas only"}
                pressed={canvasOnly}
                onClick={() => setCanvasOnly(!canvasOnly)}
              >
                {canvasOnly ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
              </HeaderButton>
            )}
            {header.crumbs && <OwnerCrumbs share={backend.share} onConnect={connect} />}
            {readOnly ? (
              <h1 className="min-w-0 shrink-[4] truncate px-1.5 text-sm font-medium">
                {document.title}
              </h1>
            ) : (
              <TitleField
                title={document.title}
                onRename={(title) => commit([{ op: "set_title", title }])}
              />
            )}
            <EditorSystemPicker
              control={systemControl}
              className={cn(
                "ml-1 shrink-0",
                header.roomy ? "w-44" : "w-36",
                !header.tools && "hidden",
              )}
            />
            {document.reuse !== undefined && document.designSystem === null ? (
              <ReuseChip
                reuse={document.reuse}
                named={header.roomy}
                onOpenSettings={() => void router.navigate({ to: "/settings/design-systems" })}
              />
            ) : null}
            <SaveState state={snapshot.saveState} label={header.saveLabel} roomy={header.roomy} />
            {snapshot.saveState === "error" && (
              <Button variant="ghost" size="xs" onClick={() => void session.flush()}>
                Retry
              </Button>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
              <HeaderButton
                label="Undo (Cmd+Z)"
                className={headerTool}
                disabled={readOnly || !snapshot.canUndo}
                onClick={undo}
              >
                <Undo2Icon />
              </HeaderButton>
              <HeaderButton
                label="Redo (Shift+Cmd+Z)"
                className={headerTool}
                disabled={readOnly || !snapshot.canRedo}
                onClick={redo}
              >
                <Redo2Icon />
              </HeaderButton>
              {layout.side === "overlay" && (
                <HeaderButton
                  label="Properties"
                  pressed={sideOverlayOpen && side === "properties"}
                  onClick={() =>
                    sideOverlayOpen && side === "properties"
                      ? setSideOverlayOpen(false)
                      : showSide("properties")
                  }
                >
                  <PanelRightIcon />
                </HeaderButton>
              )}
              <HeaderButton
                label="Comments"
                pressed={sideVisible && side === "comments"}
                onClick={() => toggleSide("comments")}
              >
                <MessageSquareIcon />
              </HeaderButton>
              {versions !== null && (
                <HeaderButton
                  label="Version history"
                  className={headerTool}
                  pressed={sideVisible && side === "history"}
                  onClick={() => toggleSide("history")}
                >
                  <HistoryIcon />
                </HeaderButton>
              )}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Export"
                      className={headerTool}
                    />
                  }
                >
                  <DownloadIcon />
                </MenuTrigger>
                <MenuPopup align="end" className="min-w-56">
                  {exportItems(targetFrame())}
                </MenuPopup>
              </Menu>
              {backend.startCodingThread !== null && (
                <HeaderButton
                  label="Implement this frame"
                  className={headerTool}
                  disabled={targetFrame() === null}
                  onClick={() => setImplementFrame(targetFrame())}
                >
                  <CodeIcon />
                </HeaderButton>
              )}
              <HeaderButton label="Present" className={headerTool} onClick={() => presentStart()}>
                <PlayIcon />
              </HeaderButton>
              {slides && (
                <HeaderButton
                  label="Presenter view"
                  className={headerTool}
                  onClick={() => presentStart(true)}
                >
                  <PresentationIcon />
                </HeaderButton>
              )}
              <EditorMoreMenu
                narrow={!header.tools}
                crumbs={header.crumbs}
                places={places}
                onUndo={readOnly || !snapshot.canUndo ? null : undo}
                onRedo={readOnly || !snapshot.canRedo ? null : redo}
                system={systemControl}
                onConnect={connect}
                onHistory={versions === null ? null : () => showSide("history")}
                exportItems={exportItems(targetFrame())}
                onImplement={
                  backend.startCodingThread === null ? null : () => setImplementFrame(targetFrame())
                }
                implementDisabled={targetFrame() === null}
                onPresent={() => presentStart()}
                onPresenterView={slides ? () => presentStart(true) : null}
              />
              <Button
                size="sm"
                className={cn("ml-1 shrink-0", !header.tools && "px-2")}
                aria-label="Share"
                onClick={() => setShareOpen(true)}
              >
                <Share2Icon />
                {header.tools && <span>Share</span>}
              </Button>
            </div>
          </WorkspacePageHeader>
        </TooltipProvider>
        <div
          ref={body}
          className="relative flex min-h-0 min-w-0 flex-1"
          data-chat={layout.chat}
          data-side={layout.side}
        >
          {(layout.chat === "column" || (layout.chat === "overlay" && chatOverlayOpen)) && (
            <section
              aria-label="Design thread"
              data-testid="design-thread"
              className={cn(
                "flex min-h-0 min-w-0 shrink-0 flex-col",
                layout.chat === "overlay" &&
                  "absolute inset-y-0 left-0 z-30 max-w-[calc(100%-3rem)] border-r border-border/70 bg-background shadow-lg",
              )}
              style={{ width: layout.chatWidth }}
            >
              <BoundThreadPane
                binding={shownBinding}
                environmentId={backend.environmentId}
                machine={backend.machine}
                renderChat={renderChat}
                onStartThread={startThread}
                canStart={!readOnly}
                onOpenThere={backend.openThread}
                notice={threadNotice({
                  binding,
                  selfBinding,
                  providerReady: backend.providerReady,
                  started: binding === null ? undefined : backend.threadStarted?.(binding),
                })}
              />
            </section>
          )}
          {layout.chat === "column" && <Divider width={layout.chatWidth} onChange={setChatWidth} />}
          <section aria-label="Canvas" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="relative flex min-h-0 flex-1">
              {slides && (
                <SlideRail
                  document={document}
                  pageId={page.id}
                  system={data.system}
                  readOnly={readOnly}
                  compact={layout.rail === "compact"}
                  onSelect={(next) => next !== page.id && changePage(next)}
                  onCommit={commit}
                />
              )}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
                  <DesignCanvas
                    session={session}
                    page={page}
                    comments={threadRoots}
                    camera={camera}
                    tool={tool}
                    onToolChange={setTool}
                    selection={selection}
                    onSelectionChange={setSelection}
                    readOnly={readOnly}
                    canComment={canComment}
                    activeCommentId={activeComment}
                    onOpenComment={openComment}
                    onPlaceComment={placeComment}
                    onPickImage={pickImage}
                    onDropFiles={(files, at) => void addImages(files, at)}
                    onExportFrame={(frame, anchor) => setFrameMenu({ frame, anchor })}
                    onError={reportError}
                    accessory={accessory}
                  />
                  {/* The tools wrap onto a second row rather than run past a narrow canvas. */}
                  <div
                    data-testid="canvas-toolbar"
                    className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-2"
                  >
                    <div className="pointer-events-auto flex min-w-0 flex-wrap items-center gap-0.5 rounded-lg border bg-popover/95 p-0.5 shadow-sm backdrop-blur">
                      {!slides && (
                        <>
                          <PageMenu
                            document={document}
                            pageId={page.id}
                            readOnly={readOnly}
                            onPageChange={changePage}
                            onCommit={commit}
                          />
                          <div className="h-5 border-l border-border/70" />
                        </>
                      )}
                      <ToolRail
                        tool={tool}
                        readOnly={readOnly}
                        canComment={canComment}
                        onToolChange={setTool}
                        onImage={() => pickImage()}
                      />
                      {!readOnly && (
                        <ComponentPicker
                          system={data.system}
                          mode={mode}
                          onInsert={insertComponent}
                        />
                      )}
                    </div>
                    <div className="pointer-events-auto flex shrink-0 items-center rounded-lg border bg-popover/95 p-0.5 shadow-sm backdrop-blur">
                      <ZoomMenu
                        camera={camera}
                        hasSelection={selection.length > 0}
                        onFit={() => zoomToContent(camera, page, [])}
                        onZoomToSelection={() => zoomToContent(camera, page, selection)}
                      />
                    </div>
                  </div>
                  {snapshot.conflict !== null && (
                    <div
                      role="alert"
                      data-testid="conflict-banner"
                      className="absolute top-16 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-warning/40 bg-popover px-3 py-2 text-sm shadow-md"
                    >
                      <span>
                        <span className="font-medium">Updated by the agent.</span>{" "}
                        <span className="text-muted-foreground">
                          You both changed{" "}
                          {snapshot.conflict.keys.length === 1
                            ? "the same property"
                            : `${snapshot.conflict.keys.length} of the same properties`}
                          .
                        </span>
                      </span>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => session.resolveConflict("theirs")}
                      >
                        Take theirs
                      </Button>
                      <Button size="xs" onClick={() => session.resolveConflict("mine")}>
                        Keep mine
                      </Button>
                    </div>
                  )}
                  {slides && !readOnly && isEmptySlide(page) && (
                    <SlideLayoutPrompt
                      camera={camera}
                      frame={page.nodes[0]!}
                      system={data.system}
                      onPick={(layout) => {
                        const operations = applySlideLayout(page, layout, { system: data.system });
                        if (operations !== null) commit(operations);
                      }}
                    />
                  )}
                </div>
                {slides && (
                  <SpeakerNotes
                    key={page.id}
                    page={page}
                    readOnly={readOnly}
                    onSave={(pageId, notes) => {
                      const change = setSlideNotes(document, pageId, notes);
                      if (change !== null) commit(change.operations);
                    }}
                  />
                )}
              </div>
              {sideVisible && (
                <aside
                  aria-label={
                    side === "comments"
                      ? "Comments"
                      : side === "history"
                        ? "Version history"
                        : "Properties"
                  }
                  data-testid="design-side-panel"
                  className={cn(
                    "flex w-64 shrink-0 flex-col border-l border-border/70 bg-background",
                    layout.side === "overlay" && "absolute inset-y-0 right-0 z-30 shadow-lg",
                  )}
                >
                  {side === "history" && versions !== null ? (
                    <VersionHistoryPanel
                      versions={versions}
                      revision={snapshot.base.revision}
                      readOnly={readOnly}
                      onRestore={restoreVersion}
                      onClose={() => {
                        setSide("properties");
                        setSideOverlayOpen(false);
                      }}
                    />
                  ) : side === "comments" ? (
                    <CommentsPanel
                      document={document}
                      draft={canComment ? commentDraft : null}
                      activeId={activeComment}
                      canComment={canComment}
                      canReply={backend.commentReplies === true}
                      onCommit={(operations) => commit(operations)}
                      onCancelDraft={() => setCommentDraft(null)}
                      onOpen={(comment) => {
                        openComment(comment);
                        const node =
                          comment.nodeId === null ? undefined : index.get(comment.nodeId);
                        if (node !== undefined)
                          camera.fit(pageRect(index, node), camera.get().zoom);
                      }}
                      onClose={() => {
                        setSide("properties");
                        setCommentDraft(null);
                        setSideOverlayOpen(false);
                      }}
                    />
                  ) : (
                    <PropertiesPanel
                      page={page}
                      selection={selection}
                      system={data.system}
                      mode={mode}
                      readOnly={readOnly}
                      onCommit={(operations) => commit(operations)}
                      onPreview={(operations) => session.setPreview(operations)}
                    />
                  )}
                </aside>
              )}
            </div>
          </section>
        </div>
      </div>
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
        multiple
        hidden
        data-testid="image-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) void addImages(files, imageAt.current);
        }}
      />
      {frameMenu !== null && (
        <Menu open onOpenChange={(open) => !open && setFrameMenu(null)}>
          <MenuPopup anchor={frameMenu.anchor} align="end" className="min-w-56">
            {exportItems(frameMenu.frame)}
          </MenuPopup>
        </Menu>
      )}
      {presenting !== false && (
        <PresentMode
          document={document}
          startFrameId={presenting}
          presenter={presenterView}
          onClose={() => setPresenting(false)}
        />
      )}
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        document={document}
        share={backend.share}
        canChangeAccess={backend.audience === "owner"}
        onCommit={(operations) =>
          // Access changes save on their own, so a refusal never holds back canvas edits.
          void session.applyAlone(operations).then((result) => {
            if (!result.ok) reportError(result.detail);
          })
        }
        threadTitle={
          shownBinding === null
            ? null
            : (backend.codingThreads.find(
                (thread) => thread.binding.threadId === shownBinding.threadId,
              )?.title ?? "the design thread")
        }
        onOpenThread={shownBinding === null ? null : () => backend.openThread(shownBinding)}
        onStartThread={
          shownBinding === null && !readOnly
            ? () => {
                setShareOpen(false);
                void startThread().catch((cause: unknown) =>
                  reportError(cause instanceof Error ? cause.message : String(cause)),
                );
              }
            : null
        }
        exports={[
          {
            format: "png",
            label: "PNG image",
            disabled: targetFrame() === null,
            run: async () => {
              const f = targetFrame();
              if (f !== null)
                await runExport({ pageId: page.id, frameId: f.id, format: "png", scale: 2 });
            },
          },
          {
            format: "html",
            label: "HTML",
            disabled: targetFrame() === null,
            run: async () => {
              const f = targetFrame();
              if (f !== null) await runExport({ pageId: page.id, frameId: f.id, format: "html" });
            },
          },
          {
            format: "pdf",
            label: "PDF",
            disabled: false,
            run: () => runExport({ pageId: page.id, format: "pdf" }),
          },
          ...(slides
            ? [
                {
                  format: "pptx" as const,
                  label: "PowerPoint",
                  disabled: false,
                  run: () => runExport({ pageId: page.id, format: "pptx" }),
                },
              ]
            : []),
        ]}
      />
      {implementFrame !== null && (
        <ImplementFrameDialog
          open
          onOpenChange={(open) => !open && setImplementFrame(null)}
          frameName={implementFrame.name ?? "frame"}
          threads={backend.codingThreads}
          canStartNew={backend.startCodingThread !== null}
          providerReady={backend.providerReady !== false}
          onSend={sendImplementation}
        />
      )}
    </DesignRenderContextValue>
  );
}

function HeaderButton({
  label,
  pressed,
  disabled,
  className,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={pressed === true ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={label}
            {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
            {...(className === undefined ? {} : { className })}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

function readChatWidth() {
  const stored =
    typeof localStorage === "undefined" ? null : Number(localStorage.getItem(CHAT_WIDTH_KEY));
  return stored !== null && Number.isFinite(stored) && stored >= 280 ? stored : 400;
}

/** Drag or use the arrow keys to resize the thread pane. */
function Divider({ width, onChange }: { width: number; onChange: (width: number) => void }) {
  const clamp = (value: number) =>
    Math.round(Math.min(Math.max(280, value), Math.max(320, window.innerWidth * 0.6)));
  const save = (value: number) => {
    onChange(value);
    try {
      localStorage.setItem(CHAT_WIDTH_KEY, String(value));
    } catch {
      // Storage can be unavailable; the width still applies for this view.
    }
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize thread pane"
      aria-valuenow={width}
      aria-valuemin={280}
      tabIndex={0}
      data-testid="design-divider"
      className="relative w-px shrink-0 cursor-col-resize bg-border outline-none after:absolute after:inset-y-0 after:-left-1 after:-right-1 hover:bg-primary/50 focus-visible:bg-primary"
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const start = width;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (next: PointerEvent) => onChange(clamp(start + next.clientX - startX));
        const up = (next: PointerEvent) => {
          save(clamp(start + next.clientX - startX));
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          save(clamp(width + (event.key === "ArrowLeft" ? -24 : 24)));
        }
      }}
    />
  );
}
