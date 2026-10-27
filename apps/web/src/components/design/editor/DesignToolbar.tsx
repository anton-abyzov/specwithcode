import type { DesignDocument, DesignOperation } from "@specweave-studio/contracts";
import { designId } from "@specweave-studio/shared/designOps";
import {
  CheckIcon,
  ChevronDownIcon,
  CircleIcon,
  FrameIcon,
  HandIcon,
  ImageIcon,
  MessageCircleIcon,
  MinusIcon,
  MousePointer2Icon,
  PenToolIcon,
  SquareIcon,
  StickyNoteIcon,
  TypeIcon,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { useCameraZoom, type CameraStore } from "../canvas/camera";
import { TOOLS, type CanvasTool } from "../canvas/tools";

const ICONS: Record<CanvasTool, LucideIcon> = {
  select: MousePointer2Icon,
  hand: HandIcon,
  frame: FrameIcon,
  rect: SquareIcon,
  ellipse: CircleIcon,
  line: MinusIcon,
  pen: PenToolIcon,
  text: TypeIcon,
  note: StickyNoteIcon,
  image: ImageIcon,
  comment: MessageCircleIcon,
};

/** Groups separated by a hairline: navigate, draw, annotate. */
const GROUPS: readonly (readonly CanvasTool[])[] = [
  ["select", "hand"],
  ["frame", "rect", "ellipse", "line", "pen", "text", "image"],
  ["note", "comment"],
];

const EDIT_TOOLS = new Set<CanvasTool>([
  "frame",
  "rect",
  "ellipse",
  "line",
  "pen",
  "text",
  "note",
  "image",
]);

export function ToolRail({
  tool,
  readOnly,
  canComment,
  onToolChange,
  onImage,
}: {
  tool: CanvasTool;
  readOnly: boolean;
  canComment: boolean;
  onToolChange: (tool: CanvasTool) => void;
  onImage: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Tools"
      aria-orientation="horizontal"
      className="flex min-w-0 flex-wrap items-center gap-0.5"
    >
      {GROUPS.map((group, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-wrap items-center gap-0.5",
            i > 0 && "border-l border-border/70 pl-0.5",
          )}
        >
          {group.map((item) => {
            const info = TOOLS.find((candidate) => candidate.tool === item)!;
            const Icon = ICONS[item];
            const disabled =
              (readOnly && EDIT_TOOLS.has(item)) || (item === "comment" && !canComment);
            if (disabled) return null;
            const label =
              info.key === null ? info.label : `${info.label} (${info.key.toUpperCase()})`;
            return (
              <Tooltip key={item}>
                <TooltipTrigger
                  render={
                    <Button
                      variant={tool === item ? "secondary" : "ghost"}
                      size="icon-sm"
                      aria-label={label}
                      aria-pressed={tool === item}
                      data-tool={item}
                      onClick={() => (item === "image" ? onImage() : onToolChange(item))}
                    >
                      <Icon />
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">{label}</TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** The `move_page` operations that move a page one place up or down; null at either end. */
export function pageMoves(
  document: DesignDocument,
  pageId: string,
): { readonly up: DesignOperation | null; readonly down: DesignOperation | null } {
  const index = document.pages.findIndex((page) => page.id === pageId);
  if (index < 0) return { up: null, down: null };
  return {
    up: index > 0 ? { op: "move_page", pageId, index: index - 1 } : null,
    down: index < document.pages.length - 1 ? { op: "move_page", pageId, index: index + 1 } : null,
  };
}

export function PageMenu({
  document,
  pageId,
  readOnly,
  onPageChange,
  onCommit,
}: {
  document: DesignDocument;
  pageId: string;
  readOnly: boolean;
  onPageChange: (pageId: string) => void;
  onCommit: (operations: DesignOperation[]) => boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const page = document.pages.find((candidate) => candidate.id === pageId) ?? document.pages[0]!;
  const moves = pageMoves(document, page.id);
  const addPage = () => {
    const id = designId("p");
    const name = `Page ${document.pages.length + 1}`;
    if (onCommit([{ op: "add_page", page: { id, name, nodes: [] } }])) onPageChange(id);
  };
  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="max-w-40"
              aria-label={`Page: ${page.name}`}
              data-testid="page-menu"
            />
          }
        >
          <span className="truncate">{page.name}</span>
          <ChevronDownIcon className="size-3.5 opacity-60" />
        </MenuTrigger>
        <MenuPopup align="start" className="min-w-48">
          {document.pages.map((candidate) => (
            <MenuItem key={candidate.id} onClick={() => onPageChange(candidate.id)}>
              <CheckIcon className={cn("size-3.5", candidate.id !== page.id && "invisible")} />
              <span className="truncate">{candidate.name}</span>
            </MenuItem>
          ))}
          {!readOnly && (
            <>
              <MenuSeparator />
              <MenuItem onClick={addPage}>Add page</MenuItem>
              <MenuItem onClick={() => setRenaming(true)}>Rename page</MenuItem>
              {document.pages.length > 1 && (
                <>
                  <MenuItem
                    disabled={moves.up === null}
                    onClick={() => moves.up !== null && onCommit([moves.up])}
                    data-testid="page-move-up"
                  >
                    Move up
                  </MenuItem>
                  <MenuItem
                    disabled={moves.down === null}
                    onClick={() => moves.down !== null && onCommit([moves.down])}
                    data-testid="page-move-down"
                  >
                    Move down
                  </MenuItem>
                </>
              )}
              {document.pages.length > 1 && (
                <MenuItem
                  variant="destructive"
                  onClick={() => {
                    const next = document.pages.find((candidate) => candidate.id !== page.id)!;
                    if (onCommit([{ op: "delete_page", pageId: page.id }])) onPageChange(next.id);
                  }}
                >
                  Delete page
                </MenuItem>
              )}
            </>
          )}
        </MenuPopup>
      </Menu>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogPopup className="max-w-sm">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
              if (name !== "" && name !== page.name)
                onCommit([{ op: "update_page", pageId: page.id, name }]);
              setRenaming(false);
            }}
          >
            <DialogHeader>
              <DialogTitle>Rename page</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Input
                name="name"
                aria-label="Page name"
                defaultValue={page.name}
                autoFocus
                maxLength={180}
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
              <Button type="submit">Rename</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

export function ZoomMenu({
  camera,
  onFit,
  onZoomToSelection,
  hasSelection,
}: {
  camera: CameraStore;
  onFit: () => void;
  onZoomToSelection: () => void;
  hasSelection: boolean;
}) {
  const zoom = useCameraZoom(camera);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Zoom ${Math.round(zoom * 100)}%`}
            data-testid="zoom-menu"
          />
        }
      >
        <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
        <ChevronDownIcon className="size-3.5 opacity-60" />
      </MenuTrigger>
      <MenuPopup align="end" className="min-w-52">
        <MenuItem onClick={() => camera.zoomTo(zoom * 1.25)}>Zoom in</MenuItem>
        <MenuItem onClick={() => camera.zoomTo(zoom / 1.25)}>Zoom out</MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onFit}>
          Zoom to fit<MenuShortcut>Shift+1</MenuShortcut>
        </MenuItem>
        <MenuItem disabled={!hasSelection} onClick={onZoomToSelection}>
          Zoom to selection<MenuShortcut>Shift+2</MenuShortcut>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => camera.zoomTo(0.5)}>50%</MenuItem>
        <MenuItem onClick={() => camera.zoomTo(1)}>
          100%<MenuShortcut>Shift+0</MenuShortcut>
        </MenuItem>
        <MenuItem onClick={() => camera.zoomTo(2)}>200%</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
