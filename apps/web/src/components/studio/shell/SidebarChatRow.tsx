/**
 * One chat in the sidebar's Chats list. A click opens the chat; a double click
 * renames it in place, the way a project row does. Chats a coordinator named
 * keep their title, so they open but do not rename.
 */
import { MoreHorizontalIcon, PencilIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { SidebarNameEditor, type ProjectRename, type RenameState } from "./SidebarProjectList";
import { Tip } from "./Tip";

export function SidebarChatRow(props: {
  title: string;
  tone: string;
  /** The row's hover label. */
  tip: string;
  current: boolean;
  /** The model mark, shown again in front of the name while renaming. */
  icon: ReactNode;
  /** What follows the name: plan chip, machine icon, screen-reader text, status dot. */
  children?: ReactNode;
  /** The row menu's items after Open and Rename. */
  menuItems: ReactNode;
  onOpen: () => void;
  /** Absent where the title cannot change; a double click then only opens the chat. */
  rename?: ProjectRename | undefined;
}) {
  const [renaming, setRenaming] = useState<RenameState | null>(null);
  // Losing the right to rename mid-edit ends the edit; it does not come back later.
  if (renaming !== null && !props.rename) setRenaming(null);
  const refocusRow = useRef(false);
  // Renaming from the menu waits for it to close, and the menu then leaves focus
  // alone: a closing menu takes focus back, which would end the edit at once.
  const renameFromMenu = useRef(false);
  const keepMenuFocus = useRef(true);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (renaming !== null || !refocusRow.current) return;
    refocusRow.current = false;
    rowRef.current?.focus();
  }, [renaming]);
  // An empty title shows as "Untitled chat" but edits as empty.
  const startRename = () => setRenaming({ draft: props.title, error: null });
  const label = props.title || "Untitled chat";
  return (
    <li
      className="sws-chat-row"
      data-tone={props.tone}
      data-renaming={(renaming !== null && props.rename !== undefined) || undefined}
    >
      {renaming !== null && props.rename ? (
        <SidebarNameEditor
          icon={props.icon}
          label="Chat name"
          rename={props.rename}
          state={renaming}
          onChange={setRenaming}
          onDone={(refocus) => {
            refocusRow.current = refocus;
            setRenaming(null);
          }}
        />
      ) : (
        <Tip side="right" label={props.tip}>
          <button
            ref={rowRef}
            type="button"
            className="sws-side-row"
            aria-current={props.current ? "page" : undefined}
            onClick={props.onOpen}
            // The second press of a double click must not select the name's text.
            onMouseDown={(event) => {
              if (event.detail > 1) event.preventDefault();
            }}
            onDoubleClick={(event) => {
              if (!props.rename || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                return;
              event.preventDefault();
              startRename();
            }}
          >
            {props.icon}
            <span className="sws-side-row-label">{label}</span>
            {props.children}
          </button>
        </Tip>
      )}
      <Menu
        onOpenChangeComplete={(open) => {
          if (open || !renameFromMenu.current) return;
          renameFromMenu.current = false;
          startRename();
        }}
      >
        <MenuTrigger
          render={
            <button
              type="button"
              className="sws-icon-button sws-chat-menu"
              aria-label={`Actions for ${label}`}
            />
          }
        >
          <MoreHorizontalIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup
          align="start"
          side="bottom"
          finalFocus={() => {
            const keep = keepMenuFocus.current;
            keepMenuFocus.current = true;
            return keep;
          }}
        >
          <MenuItem onClick={props.onOpen}>Open</MenuItem>
          {props.rename ? (
            <MenuItem
              onClick={() => {
                renameFromMenu.current = true;
                keepMenuFocus.current = false;
              }}
            >
              <PencilIcon aria-hidden />
              Rename
            </MenuItem>
          ) : null}
          {props.menuItems}
        </MenuPopup>
      </Menu>
    </li>
  );
}
