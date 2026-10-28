/**
 * Components as cards, the way a design tool shows a kit: grouped by where they
 * come from, each with its stories rendered in light and dark. A built preview
 * (the kit's own stories rendered when the system was imported) is static HTML
 * in a frame that runs no script and loads nothing from the network, with the
 * kit's stylesheet; the frame is same-origin only so the page can size it to
 * its content. Hand-written previews keep the opaque-origin frame with the
 * system's tokens. Frames load only once they scroll near the viewport.
 */
import type {
  DesignNode,
  DesignOwnerInput,
  DesignSystem,
  DesignSystemComponent,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  designComponentSrcdoc,
  designPreviewSrcdoc,
  type DesignPreviewTheme,
} from "@specweave-studio/shared/designRender";
import { RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useAtomCommand } from "~/state/use-atom-command";
import { designSystemImport } from "~/studio/designSystemImport";

import { Button } from "../../../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../../ui/dialog";
import { Input } from "../../../ui/input";
import { Label } from "../../../ui/label";
import { Textarea } from "../../../ui/textarea";
import { Toggle, ToggleGroup } from "../../../ui/toggle-group";
import { NearViewport } from "../../gallery/DesignThumbnail";
import { failureText } from "../reviewModel";
import {
  componentGroups,
  NO_PREVIEW,
  previewKind,
  previewSummary,
  storyNames,
} from "./componentCards";
import { DialogConflictNotice } from "./DialogConflictNotice";
import { readText, useSystemFilesApi, type SystemFilesApi } from "./systemFilesApi";
import { newComponentId, type SystemEditIntent } from "./systemEditIntents";
import { shadowStage } from "./tokenValues";

export { NO_PREVIEW };

/** The frame document: the shared component preview, which carries the tokens of one mode. */
export function componentPreviewSrcdoc(
  system: DesignSystem,
  component: DesignSystemComponent,
  modeId: string,
): string {
  const node: Extract<DesignNode, { type: "component" }> = {
    id: "preview",
    parentId: null,
    type: "component",
    componentId: component.id,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  return designComponentSrcdoc(node, { system, mode: modeId, assetUrl: () => "" });
}

type ThemeChoice = DesignPreviewTheme | "both";
const THEMES: Record<ThemeChoice, ReadonlyArray<DesignPreviewTheme>> = {
  both: ["light", "dark"],
  light: ["light"],
  dark: ["dark"],
};
/** A frame grows with its stories up to this height, then scrolls inside. */
const FRAME_MAX_HEIGHT = 640;

/**
 * Reads stored preview files once per build. Reads are keyed by `builtAt`, so after a
 * rebuild every card and the stylesheet get a new reader and read the rebuilt files.
 */
function usePreviewText(api: SystemFilesApi, builtAt: string | undefined) {
  const cache = useRef(new Map<string, Promise<string | null>>());
  return useCallback(
    (path: string) => {
      const key = `${builtAt ?? ""}\n${path}`;
      let pending = cache.current.get(key);
      if (pending === undefined) {
        pending = api
          .read({ origin: "stored", path })
          .then((outcome) => (outcome.ok ? readText(outcome.value) : null));
        cache.current.set(key, pending);
      }
      return pending;
    },
    [api, builtAt],
  );
}

export interface ComponentsSectionProps {
  readonly environmentId: EnvironmentId;
  readonly owner: DesignOwnerInput;
  readonly system: DesignSystem;
  readonly canEdit: boolean;
  readonly onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  /** The system changed outside the edit queue (a rebuild wrote it). */
  readonly onChanged?: (() => void) | undefined;
}

export function ComponentsSection(props: ComponentsSectionProps) {
  const api = useSystemFilesApi({
    environmentId: props.environmentId,
    owner: props.owner,
    systemId: props.system.id,
  });
  const rebuild = useAtomCommand(designSystemImport.rebuildPreviews, { reportFailure: false });
  const { environmentId, owner, system, onChanged } = props;
  const refreshFiles = api.listing.refresh;
  const onRebuild = useCallback(async (): Promise<ReadonlyArray<string>> => {
    const projectId = owner.kind === "project" ? owner.projectId : null;
    const result = await rebuild({
      environmentId,
      input: {
        owner: projectId === null ? { kind: "playground" } : { kind: "project", projectId },
        systemId: system.id,
      },
    });
    if (result._tag === "Failure") {
      return [failureText(squashAtomCommandFailure(result), "Previews were not rebuilt.")];
    }
    refreshFiles();
    onChanged?.();
    return result.value.problems;
  }, [environmentId, onChanged, owner, rebuild, refreshFiles, system.id]);
  return (
    <ComponentsSectionView
      system={system}
      canEdit={props.canEdit}
      onEdit={props.onEdit}
      api={api}
      onRebuild={system.sources.some((source) => source.kind === "file") ? onRebuild : null}
    />
  );
}

export function ComponentsSectionView({
  system,
  canEdit,
  onEdit,
  api,
  onRebuild,
}: {
  system: DesignSystem;
  canEdit: boolean;
  onEdit: (intent: SystemEditIntent) => Promise<boolean>;
  api: SystemFilesApi;
  /** Renders the components again from project code; null when the system has none. */
  onRebuild: (() => Promise<ReadonlyArray<string>>) | null;
}) {
  const [modeId, setModeId] = useState(system.modes[0]?.id ?? "default");
  const mode = system.modes.find((candidate) => candidate.id === modeId) ?? system.modes[0];
  const ground = mode === undefined ? "#ffffff" : shadowStage(system, mode).ground;
  const [theme, setTheme] = useState<ThemeChoice>("both");
  const [query, setQuery] = useState("");
  const [rebuilding, setRebuilding] = useState(false);
  const [problems, setProblems] = useState<ReadonlyArray<string>>([]);
  const read = usePreviewText(api, system.previews?.builtAt);
  const [css, setCss] = useState<string | null>(null);
  const stylesheet = system.previews?.stylesheetFile;
  useEffect(() => {
    let live = true;
    setCss(null);
    if (stylesheet === undefined) return;
    void read(stylesheet).then((text) => {
      if (live) setCss(text ?? "");
    });
    return () => {
      live = false;
    };
  }, [read, stylesheet]);
  const groups = useMemo(
    () => componentGroups(system.components, query),
    [query, system.components],
  );
  const hasHtml = system.components.some((component) => previewKind(component).kind === "html");
  const hasBuilt = system.previews !== undefined;
  const summary = previewSummary(system);
  // A rebuild's own problems first; otherwise what the stored build recorded.
  const shownProblems = problems.length > 0 ? problems : (system.previews?.problems ?? []);
  if (system.components.length === 0) return null;

  const runRebuild = async () => {
    if (onRebuild === null || rebuilding) return;
    setRebuilding(true);
    setProblems([]);
    setProblems(await onRebuild());
    setRebuilding(false);
  };

  return (
    <div className="flex flex-col gap-4 px-3 pb-4 sm:px-4" data-testid="components-section">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <Input
            size="sm"
            type="search"
            aria-label="Find a component"
            placeholder={`Find among ${system.components.length.toLocaleString("en-US")} components`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {hasBuilt ? (
          <ToggleGroup
            aria-label="Preview theme"
            value={[theme]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "both" || value === "light" || value === "dark") setTheme(value);
            }}
          >
            <Toggle value="both" size="sm">
              Both
            </Toggle>
            <Toggle value="light" size="sm">
              Light
            </Toggle>
            <Toggle value="dark" size="sm">
              Dark
            </Toggle>
          </ToggleGroup>
        ) : null}
        {hasHtml && system.modes.length > 1 ? (
          <ToggleGroup
            aria-label="Preview mode"
            value={[modeId]}
            onValueChange={(next) => {
              const value = next[0];
              if (typeof value === "string") setModeId(value);
            }}
          >
            {system.modes.map((candidate) => (
              <Toggle key={candidate.id} value={candidate.id} size="sm">
                {candidate.name}
              </Toggle>
            ))}
          </ToggleGroup>
        ) : null}
        {onRebuild !== null && canEdit ? (
          <Button
            variant="outline"
            size="xs"
            className="ml-auto"
            disabled={rebuilding}
            onClick={() => void runRebuild()}
            data-testid="rebuild-previews"
          >
            <RefreshCwIcon aria-hidden className={rebuilding ? "animate-spin" : undefined} />
            {rebuilding ? "Rendering stories…" : hasBuilt ? "Rebuild previews" : "Build previews"}
          </Button>
        ) : null}
      </div>
      {summary !== null || shownProblems.length > 0 ? (
        <div className="flex flex-col gap-1 text-muted-foreground text-xs">
          {summary !== null ? <p data-testid="previews-summary">{summary}</p> : null}
          {shownProblems.map((problem) => (
            <p key={problem} role="alert" className="text-warning-foreground">
              {problem}
            </p>
          ))}
        </div>
      ) : null}
      {groups.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground text-sm">No component matches.</p>
      ) : null}
      {groups.map((group) => (
        <section key={group.name} aria-label={group.name} className="flex flex-col gap-3">
          <h3 className="flex items-baseline gap-2 font-medium text-foreground text-sm">
            {group.name}
            <span className="font-normal text-muted-foreground text-xs tabular-nums">
              {group.components.length}
            </span>
          </h3>
          <div className="flex flex-col gap-3">
            {group.components.map((component) => (
              <ComponentCard
                key={component.id}
                system={system}
                component={component}
                themes={THEMES[theme]}
                css={css}
                read={read}
                modeId={mode?.id ?? modeId}
                ground={ground}
                canEdit={canEdit}
                onRemove={() => void onEdit({ kind: "remove-component", id: component.id })}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ComponentCard({
  system,
  component,
  themes,
  css,
  read,
  modeId,
  ground,
  canEdit,
  onRemove,
}: {
  system: DesignSystem;
  component: DesignSystemComponent;
  themes: ReadonlyArray<DesignPreviewTheme>;
  css: string | null;
  read: (path: string) => Promise<string | null>;
  modeId: string;
  ground: string;
  canEdit: boolean;
  onRemove: () => void;
}) {
  const preview = previewKind(component);
  const [stories, setStories] = useState<number | null>(null);
  const meta = [
    component.framework === "css-class" ? "CSS class" : component.framework,
    component.importPath,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      data-testid="component-row"
      data-token-row={component.name}
      className="group/row overflow-hidden rounded-xl border border-border/80 bg-card"
    >
      <header className="flex min-w-0 items-center gap-3 border-border/60 border-b px-4 py-2.5">
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium font-mono text-foreground text-sm">
            {component.name}
          </span>
          {meta !== "" ? (
            <span className="truncate text-muted-foreground text-xs">{meta}</span>
          ) : null}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {stories !== null && stories > 0 ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {stories === 1 ? "1 story" : `${stories} stories`}
            </span>
          ) : null}
          {canEdit ? (
            <Button
              variant="ghost-destructive"
              size="icon-xs"
              aria-label={`Remove ${component.name}`}
              className="opacity-0 transition-opacity duration-[120ms] group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
              onClick={onRemove}
            >
              <Trash2Icon aria-hidden />
            </Button>
          ) : null}
        </div>
      </header>
      {preview.kind === "built" ? (
        <BuiltPreview
          component={component}
          file={preview.file}
          themes={themes}
          css={css}
          read={read}
          onStories={setStories}
        />
      ) : preview.kind === "html" ? (
        <div className="p-3">
          <PreviewFrame system={system} component={component} modeId={modeId} ground={ground} />
        </div>
      ) : (
        <p className="px-4 py-3 text-muted-foreground text-sm">{preview.note}</p>
      )}
    </article>
  );
}

function BuiltPreview({
  component,
  file,
  themes,
  css,
  read,
  onStories,
}: {
  component: DesignSystemComponent;
  file: string;
  themes: ReadonlyArray<DesignPreviewTheme>;
  css: string | null;
  read: (path: string) => Promise<string | null>;
  onStories: (count: number) => void;
}) {
  return (
    <NearViewport className="min-h-24">
      <BuiltFrames
        component={component}
        file={file}
        themes={themes}
        css={css}
        read={read}
        onStories={onStories}
      />
    </NearViewport>
  );
}

function BuiltFrames({
  component,
  file,
  themes,
  css,
  read,
  onStories,
}: {
  component: DesignSystemComponent;
  file: string;
  themes: ReadonlyArray<DesignPreviewTheme>;
  css: string | null;
  read: (path: string) => Promise<string | null>;
  onStories: (count: number) => void;
}) {
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void read(file).then((text) => {
      if (!live) return;
      setHtml(text);
      if (text !== null) onStories(storyNames(text).length);
    });
    return () => {
      live = false;
    };
  }, [file, onStories, read]);
  if (html === null) {
    return (
      <p className="px-4 py-3 text-muted-foreground text-sm">
        Its preview file is missing. Rebuild previews to render it again.
      </p>
    );
  }
  if (html === undefined || css === null) {
    return <div className="h-24 animate-pulse bg-muted/40" aria-hidden />;
  }
  return (
    <div className={themes.length > 1 ? "grid grid-cols-1 lg:grid-cols-2" : ""}>
      {themes.map((theme) => (
        <BuiltFrame key={theme} component={component} html={html} css={css} theme={theme} />
      ))}
    </div>
  );
}

/** Sizes a same-origin frame to its content and gives SVG fragments a viewBox that fits them. */
function fitFrame(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  if (document === null) return;
  for (const svg of document.querySelectorAll<SVGSVGElement>("svg[data-swc-fragment]")) {
    if (svg.hasAttribute("viewBox")) continue;
    try {
      const box = svg.getBBox();
      if (box.width > 0 && box.height > 0) {
        const pad = Math.max(box.width, box.height) * 0.04;
        svg.setAttribute(
          "viewBox",
          `${box.x - pad} ${box.y - pad} ${box.width + pad * 2} ${box.height + pad * 2}`,
        );
      }
    } catch {
      // Not laid out yet; the next resize fits it.
    }
  }
  // Kits often wrap stories in a full-viewport page (`min-height: 100vh`): measured in a
  // 1px frame, the content alone sets the height.
  frame.style.height = "1px";
  const height = Math.ceil(document.documentElement.scrollHeight);
  frame.style.height = `${Math.min(Math.max(height, 64), FRAME_MAX_HEIGHT)}px`;
}

/** Fits again only when the content outgrows the frame (a font or image arrived late). */
function outgrown(frame: HTMLIFrameElement) {
  const document = frame.contentDocument;
  if (document === null) return false;
  const height = Number.parseFloat(frame.style.height) || 0;
  return height < FRAME_MAX_HEIGHT && document.documentElement.scrollHeight > height + 1;
}

function BuiltFrame({
  component,
  html,
  css,
  theme,
}: {
  component: DesignSystemComponent;
  html: string;
  css: string;
  theme: DesignPreviewTheme;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => designPreviewSrcdoc({ html, css, theme }), [css, html, theme]);
  useEffect(() => {
    const frame = ref.current;
    if (frame === null) return;
    let observer: ResizeObserver | null = null;
    const onLoad = () => {
      fitFrame(frame);
      observer?.disconnect();
      const body = frame.contentDocument?.body;
      if (body && typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(() => {
          if (outgrown(frame)) fitFrame(frame);
        });
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, []);
  return (
    <div className="relative min-w-0" data-theme-frame={theme}>
      <iframe
        ref={ref}
        title={`${component.name} preview, ${theme}`}
        sandbox="allow-same-origin"
        srcDoc={srcDoc}
        tabIndex={-1}
        data-testid="component-preview"
        className="block h-24 w-full border-0"
        style={{ colorScheme: theme, backgroundColor: theme === "dark" ? "#101114" : "#ffffff" }}
      />
      <span
        className={`pointer-events-none absolute top-2 right-3 rounded-md px-1.5 py-0.5 font-medium text-3xs uppercase tracking-wide ${theme === "dark" ? "bg-white/10 text-white/60" : "bg-black/5 text-black/45"}`}
      >
        {theme}
      </span>
    </div>
  );
}

function PreviewFrame({
  system,
  component,
  modeId,
  ground,
}: {
  system: DesignSystem;
  component: DesignSystemComponent;
  modeId: string;
  ground: string;
}) {
  const srcDoc = useMemo(
    () => componentPreviewSrcdoc(system, component, modeId),
    [component, modeId, system],
  );
  return (
    <NearViewport className="h-36 w-full overflow-hidden rounded-lg ring-1 ring-black/5 ring-inset dark:ring-white/8">
      <iframe
        title={`${component.name} preview`}
        sandbox=""
        srcDoc={srcDoc}
        loading="lazy"
        tabIndex={-1}
        data-testid="component-preview"
        className="block size-full border-0"
        style={{ backgroundColor: ground }}
      />
    </NearViewport>
  );
}

/** A component written by hand: a name and the static HTML its preview shows. */
export function AddComponentDialog({
  system,
  conflict = false,
  onReload,
  onOpenChange,
  onAdd,
}: {
  system: DesignSystem;
  /** The last save hit a revision conflict; Add waits for Reload. */
  conflict?: boolean;
  onReload?: () => void;
  onOpenChange: (open: boolean) => void;
  onAdd: (intent: SystemEditIntent) => Promise<boolean>;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [html, setHtml] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (!conflict) setRefused(false);
  }, [conflict]);
  const taken = system.components.some(
    (component) => component.name.toLowerCase() === name.trim().toLowerCase(),
  );
  const problem =
    name.trim() === ""
      ? "A component needs a name."
      : taken
        ? `“${name.trim()}” already exists.`
        : null;
  const submit = async () => {
    if (problem !== null || conflict || busy) return;
    setBusy(true);
    const saved = await onAdd({
      kind: "put-component",
      component: {
        id: newComponentId(
          name,
          system.components.map((component) => component.id),
        ),
        name: name.trim(),
        framework: "html",
        ...(html.trim() === "" ? {} : { previewHtml: html.trim() }),
      },
    });
    setBusy(false);
    if (saved) onOpenChange(false);
    else setRefused(true);
  };
  return (
    <Dialog open onOpenChange={(open) => !busy && onOpenChange(open)}>
      <DialogPopup className="sm:max-w-lg" data-testid="add-component-dialog">
        <DialogHeader>
          <DialogTitle>Add component</DialogTitle>
          <DialogDescription>
            Its preview is static HTML that can use the tokens as CSS variables, for example
            var(--color-brand).
          </DialogDescription>
          {conflict && onReload ? (
            <DialogConflictNotice refused={refused} onReload={onReload} />
          ) : null}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-name`}>Name</Label>
              <Input
                id={`${id}-name`}
                size="sm"
                autoFocus
                placeholder="e.g. Button"
                value={name}
                maxLength={200}
                aria-invalid={name !== "" && problem !== null}
                onChange={(event) => setName(event.target.value)}
              />
              {name !== "" && problem !== null ? (
                <span role="alert" className="text-destructive-foreground text-xs">
                  {problem}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-html`}>Preview HTML</Label>
              <Textarea
                id={`${id}-html`}
                size="sm"
                className="font-mono text-xs"
                placeholder={'<button style="background:var(--color-brand)">Book</button>'}
                value={html}
                maxLength={64 * 1024}
                onChange={(event) => setHtml(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || problem !== null || conflict} onClick={() => void submit()}>
            {busy ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
