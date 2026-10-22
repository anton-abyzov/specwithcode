import {
  ArrowDownIcon,
  ArrowUpIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { MenuItem, MenuSeparator, MenuShortcut } from "~/components/ui/menu";
import { isMacPlatform } from "~/lib/utils";

/** "Cmd" on Apple platforms, "Ctrl" elsewhere: the key the rail's Mod shortcuts listen for. */
export function modifierLabel(
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): "Cmd" | "Ctrl" {
  return isMacPlatform(platform) ? "Cmd" : "Ctrl";
}

export type SlideAction = "duplicate" | "add-after" | "move-up" | "move-down" | "skip" | "delete";

/** The slide menu's items; the rail renders them in its "More" button and on right-click. */
export function SlideMenuItems({
  index,
  count,
  skipped,
  onAction,
  platform,
}: {
  index: number;
  count: number;
  skipped: boolean;
  onAction: (action: SlideAction) => void;
  /** Defaults to this browser's platform. */
  platform?: string;
}) {
  return (
    <>
      <MenuItem onClick={() => onAction("duplicate")}>
        <CopyIcon />
        Duplicate
        <MenuShortcut>{modifierLabel(platform)}+D</MenuShortcut>
      </MenuItem>
      <MenuItem onClick={() => onAction("add-after")}>
        <PlusIcon />
        Add slide after
      </MenuItem>
      <MenuSeparator />
      <MenuItem disabled={index === 0} onClick={() => onAction("move-up")}>
        <ArrowUpIcon />
        Move up
        <MenuShortcut>Alt+Up</MenuShortcut>
      </MenuItem>
      <MenuItem disabled={index >= count - 1} onClick={() => onAction("move-down")}>
        <ArrowDownIcon />
        Move down
        <MenuShortcut>Alt+Down</MenuShortcut>
      </MenuItem>
      <MenuSeparator />
      <MenuItem onClick={() => onAction("skip")}>
        {skipped ? <EyeIcon /> : <EyeOffIcon />}
        {skipped ? "Show slide" : "Skip slide"}
      </MenuItem>
      <MenuItem variant="destructive" disabled={count === 1} onClick={() => onAction("delete")}>
        <Trash2Icon />
        Delete
        <MenuShortcut>Delete</MenuShortcut>
      </MenuItem>
    </>
  );
}
