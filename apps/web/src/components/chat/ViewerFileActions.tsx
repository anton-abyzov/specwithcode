import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  CopyIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderOpenIcon,
  SquarePenIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { openInEditorMenuLabel } from "~/editorLabels";
import { usePreferredEditor } from "~/editorPreferences";
import { useFileContextMenu } from "~/fileContextMenu";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

/**
 * A viewer header's file actions: open in the preferred editor, reveal in the
 * file manager, and a ⋯ menu with the viewer's own items, the other editors
 * and the default app, and copying the path. Only what the host offers shows.
 */
export function ViewerFileActions(props: {
  readonly environmentId: EnvironmentId;
  /** The file's absolute host path; null for something that is not a file. */
  readonly path: string | null;
  /** The viewer's own menu items, listed first. */
  readonly menuItems?: ReactNode;
  /** Copied when there is no path. */
  readonly name: string;
}) {
  const files = useFileContextMenu(props.environmentId);
  const [editor] = usePreferredEditor(files.capabilities.editorIds);
  const target = props.path
    ? { environmentId: props.environmentId, filePath: props.path, workspaceRoot: undefined }
    : null;
  const canEdit = target !== null && editor !== null && editor !== "file-manager";
  const revealLabel = target ? files.capabilities.revealLabel : undefined;
  const otherEditors = target
    ? files.capabilities.editorIds.filter((id) => id !== "file-manager" && id !== editor)
    : [];
  const path = props.path;
  return (
    <>
      {canEdit ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={openInEditorMenuLabel(editor)}
          title={openInEditorMenuLabel(editor)}
          onClick={() => void files.activate(`editor:${editor}`, target)}
        >
          <SquarePenIcon aria-hidden />
        </Button>
      ) : null}
      {target && revealLabel ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={revealLabel}
          title={revealLabel}
          onClick={() => void files.activate("reveal-in-folder", target)}
        >
          <FolderOpenIcon aria-hidden />
        </Button>
      ) : null}
      <Menu>
        <MenuTrigger render={<Button aria-label="More actions" size="icon-sm" variant="ghost" />}>
          <EllipsisIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup align="end">
          {props.menuItems}
          {target && files.capabilities.canOpenDefault ? (
            <MenuItem onClick={() => void files.activate("open", target)}>
              <ExternalLinkIcon aria-hidden />
              Open with default app
            </MenuItem>
          ) : null}
          {otherEditors.map((id) => (
            <MenuItem key={id} onClick={() => void files.activate(`editor:${id}`, target!)}>
              <SquarePenIcon aria-hidden />
              {openInEditorMenuLabel(id)}
            </MenuItem>
          ))}
          {props.menuItems ||
          (target && files.capabilities.canOpenDefault) ||
          otherEditors.length ? (
            <MenuSeparator />
          ) : null}
          <MenuItem onClick={() => void navigator.clipboard?.writeText(path ?? props.name)}>
            <CopyIcon aria-hidden />
            {path ? "Copy path" : "Copy name"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </>
  );
}
