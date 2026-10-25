/**
 * Insert component: a toolbar popover listing the bound design system's components,
 * each with a lazy, sandboxed preview in the canvas mode. Picking one puts it on the
 * canvas; the editor decides where.
 */
import type { DesignNode, DesignSystem, DesignSystemComponent } from "@specweave-studio/contracts";
import { designComponentSrcdoc } from "@specweave-studio/shared/designRender";
import { ComponentIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { NearViewport } from "../gallery/DesignThumbnail";
import { shadowStage } from "../systems/workspace/tokenValues";

/** Rows the list shows at once; search narrows a large system. */
const LIST_LIMIT = 60;

/** Components whose name or group contains `query`, case-insensitive, at most `limit`. */
export function matchComponents(
  components: readonly DesignSystemComponent[],
  query: string,
  limit = LIST_LIMIT,
): { readonly shown: readonly DesignSystemComponent[]; readonly more: number } {
  const needle = query.trim().toLowerCase();
  const matched =
    needle === ""
      ? components
      : components.filter(
          (component) =>
            component.name.toLowerCase().includes(needle) ||
            (component.group ?? "").toLowerCase().includes(needle),
        );
  return { shown: matched.slice(0, limit), more: Math.max(0, matched.length - limit) };
}

const frameworkLabel = (component: DesignSystemComponent) =>
  component.group ?? (component.framework === "css-class" ? "CSS class" : component.framework);

export function ComponentList({
  system,
  mode,
  onInsert,
}: {
  system: DesignSystem | null;
  mode: string;
  onInsert: (component: DesignSystemComponent) => void;
}) {
  const [query, setQuery] = useState("");
  const { shown, more } = useMemo(
    () => matchComponents(system?.components ?? [], query),
    [query, system],
  );
  if (system === null)
    return (
      <p className="px-1 py-2 text-muted-foreground text-sm">
        Choose a design system in the header to insert its components.
      </p>
    );
  if (system.components.length === 0)
    return (
      <p className="px-1 py-2 text-muted-foreground text-sm">
        {system.name} has no components yet. Add them on its design system page.
      </p>
    );
  const modeEntry = system.modes.find((candidate) => candidate.id === mode) ?? {
    id: mode,
    name: mode,
  };
  const ground = shadowStage(system, modeEntry).ground;
  return (
    <div className="flex flex-col gap-2" data-testid="component-picker">
      <Input
        size="sm"
        aria-label="Search components"
        placeholder="Search components"
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || shown[0] === undefined) return;
          event.preventDefault();
          onInsert(shown[0]);
        }}
      />
      {shown.length === 0 ? (
        <p className="px-1 py-2 text-muted-foreground text-sm">
          No components match “{query.trim()}”.
        </p>
      ) : (
        <ul className="-mx-1 flex max-h-80 flex-col overflow-y-auto" aria-label="Components">
          {shown.map((component) => (
            <li
              key={component.id}
              className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60"
            >
              <div
                aria-hidden
                className="h-14 w-24 shrink-0 cursor-pointer overflow-hidden rounded-md ring-1 ring-black/5 ring-inset dark:ring-white/8"
                style={{ backgroundColor: ground }}
                onClick={() => onInsert(component)}
              >
                <ComponentPreview system={system} component={component} mode={mode} />
              </div>
              <button
                type="button"
                data-testid="component-option"
                data-component={component.id}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start rounded-sm py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onInsert(component)}
              >
                <span className="w-full truncate text-foreground text-sm">{component.name}</span>
                <span className="w-full truncate text-muted-foreground text-xs">
                  {frameworkLabel(component)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? (
        <p className="px-1 text-muted-foreground text-xs">{more} more. Type to narrow the list.</p>
      ) : null}
    </div>
  );
}

function ComponentPreview({
  system,
  component,
  mode,
}: {
  system: DesignSystem;
  component: DesignSystemComponent;
  mode: string;
}) {
  const srcDoc = useMemo(() => {
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
    return designComponentSrcdoc(node, { system, mode, assetUrl: () => "" });
  }, [component.id, mode, system]);
  if (component.previewHtml === undefined || component.previewHtml.trim() === "")
    return (
      <span className="flex size-full items-center justify-center text-muted-foreground text-xs">
        No preview
      </span>
    );
  return (
    <NearViewport className="size-full">
      <iframe
        title={`${component.name} preview`}
        sandbox=""
        srcDoc={srcDoc}
        tabIndex={-1}
        className="pointer-events-none block size-full border-0"
      />
    </NearViewport>
  );
}

/** The toolbar button and its popover; it closes once a component is inserted. */
export function ComponentPicker({
  system,
  mode,
  onInsert,
}: {
  system: DesignSystem | null;
  mode: string;
  onInsert: (component: DesignSystemComponent) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center border-l border-border/70 pl-0.5">
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <PopoverTrigger
                render={
                  <Button
                    variant={open ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-label="Insert component"
                    data-testid="insert-component"
                  />
                }
              />
            }
          >
            <ComponentIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Insert component</TooltipPopup>
        </Tooltip>
        <PopoverPopup align="start" padding="compact" className="w-[min(20rem,calc(100vw-1.5rem))]">
          <ComponentList
            system={system}
            mode={mode}
            onInsert={(component) => {
              onInsert(component);
              setOpen(false);
            }}
          />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
