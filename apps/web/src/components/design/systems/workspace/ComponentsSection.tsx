/**
 * Components as Name / Preview. Each preview is the component's static HTML
 * in an opaque-origin frame (no scripts, no same origin, no network) with the
 * system's tokens as CSS variables, drawn on the chosen mode's page ground,
 * and only once it scrolls near the viewport.
 */
import type { DesignNode, DesignSystem, DesignSystemComponent } from "@specweave-studio/contracts";
import { designComponentSrcdoc } from "@specweave-studio/shared/designRender";
import { Trash2Icon } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

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
import { DialogConflictNotice } from "./DialogConflictNotice";
import { newComponentId, type SystemEditIntent } from "./systemEditIntents";
import { GUTTER, HEADER_ROW, ROW } from "./tokenRows";
import { shadowStage } from "./tokenValues";

export const NO_PREVIEW = "No preview yet. Ask the agent to add one.";

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

export function ComponentsSection({
  system,
  canEdit,
  onEdit,
}: {
  system: DesignSystem;
  canEdit: boolean;
  onEdit: (intent: SystemEditIntent) => Promise<boolean>;
}) {
  const [modeId, setModeId] = useState(system.modes[0]?.id ?? "default");
  const mode = system.modes.find((candidate) => candidate.id === modeId) ?? system.modes[0];
  const ground = mode === undefined ? "#ffffff" : shadowStage(system, mode).ground;
  const columns = `minmax(8rem,0.7fr) minmax(12rem,2fr) ${GUTTER}`;
  if (system.components.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="components-section">
      {system.modes.length > 1 ? (
        <div className="flex items-center gap-2 px-3 text-muted-foreground text-xs">
          <span>Preview in</span>
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
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <div role="table" aria-label="Components" className="min-w-[26rem]">
          <div role="row" className={HEADER_ROW} style={{ gridTemplateColumns: columns }}>
            <span role="columnheader">Name</span>
            <span role="columnheader">Preview</span>
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {system.components.map((component) => (
            <div
              key={component.id}
              role="row"
              data-testid="component-row"
              data-token-row={component.name}
              className={ROW}
              style={{ gridTemplateColumns: columns }}
            >
              <div role="cell" className="flex min-w-0 flex-col gap-0.5 self-start pt-2">
                <span className="truncate font-mono text-[13px] text-foreground">
                  {component.name}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {[
                    component.framework === "css-class" ? "CSS class" : component.framework,
                    component.importPath,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
              <div role="cell" className="min-w-0 py-1.5">
                {component.previewHtml === undefined || component.previewHtml.trim() === "" ? (
                  <p className="py-3 text-muted-foreground text-sm">{NO_PREVIEW}</p>
                ) : (
                  <PreviewFrame
                    system={system}
                    component={component}
                    modeId={mode?.id ?? modeId}
                    ground={ground}
                  />
                )}
              </div>
              <div role="cell" className="flex justify-end self-start pt-1.5">
                {canEdit ? (
                  <Button
                    variant="ghost-destructive"
                    size="icon-xs"
                    aria-label={`Remove ${component.name}`}
                    className="opacity-0 transition-opacity duration-[120ms] group-hover/row:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    onClick={() => void onEdit({ kind: "remove-component", id: component.id })}
                  >
                    <Trash2Icon aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
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
