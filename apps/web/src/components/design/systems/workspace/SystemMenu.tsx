/**
 * The menu behind the caret next to a design system's title: when it was
 * updated, Switch system, Rename, Duplicate, Open in Settings, Rescan (for
 * systems read from files), Storage and Delete with a usage warning.
 */
import type {
  DesignSystem,
  DesignSystemId,
  DesignSystemSummary,
} from "@specweave-studio/contracts";
import {
  ChevronDownIcon,
  CopyPlusIcon,
  HardDriveIcon,
  RefreshCwIcon,
  Repeat2Icon,
  SettingsIcon,
  TextCursorInputIcon,
  Trash2Icon,
} from "lucide-react";
import { useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";
import { Button } from "../../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../../ui/menu";
import { formatBytes } from "../reviewModel";
import { deleteWarning, longDate } from "./systemText";

export interface SystemMenuProps {
  readonly system: DesignSystem;
  readonly ownerLabel: string;
  /** The owner's systems, for Switch system; null while loading. */
  readonly siblings: readonly DesignSystemSummary[] | null;
  /** The window may change files: rename, duplicate, rescan and delete. */
  readonly canManage: boolean;
  /** Stored files' use, when the server reports it. */
  readonly storage: { readonly usedBytes: number; readonly limitBytes: number } | null;
  /** Designs that use the system; null while unknown. */
  readonly usage: number | null;
  readonly onSwitch: (systemId: DesignSystemId) => void;
  readonly onRename: () => void;
  readonly onDuplicate: () => void;
  readonly onOpenSettings: () => void;
  /** Absent for systems that were not read from project files. */
  readonly onRescan?: (() => void) | null;
  readonly rescanning?: boolean;
  readonly onStorage?: (() => void) | null;
  /** Resolves to a message when the delete failed; the page leaves once it succeeds. */
  readonly onDelete: () => Promise<string | null>;
}

export function SystemMenu(props: SystemMenuProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rename opens a field in the header. It starts once the menu has closed, and
  // the menu then leaves focus alone, so it cannot pull focus out of the field.
  const afterClose = useRef<(() => void) | null>(null);
  const keepFocus = useRef(false);
  const { system } = props;
  return (
    <>
      <Menu
        onOpenChange={(open) => {
          if (open) keepFocus.current = false;
        }}
        onOpenChangeComplete={(open) => {
          const run = afterClose.current;
          afterClose.current = null;
          if (!open && run !== null) run();
        }}
      >
        <MenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Design system menu"
              data-testid="system-menu-trigger"
            />
          }
        >
          <ChevronDownIcon aria-hidden />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="min-w-60"
          data-testid="system-menu"
          finalFocus={() => !keepFocus.current}
        >
          <MenuGroup>
            <MenuGroupLabel className="font-normal" data-testid="system-menu-header">
              Design system · Updated {longDate(system.updatedAt)}
            </MenuGroupLabel>
          </MenuGroup>
          <MenuSub>
            <MenuSubTrigger>
              <Repeat2Icon aria-hidden />
              Switch system
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-56" data-testid="system-switch">
              {props.siblings === null ? (
                <MenuItem disabled>Loading design systems…</MenuItem>
              ) : (
                <MenuRadioGroup
                  value={system.id}
                  onValueChange={(value) => {
                    if (typeof value === "string" && value !== system.id)
                      props.onSwitch(value as DesignSystemId);
                  }}
                >
                  {props.siblings.map((sibling) => (
                    <MenuRadioItem key={sibling.ref.systemId} value={sibling.ref.systemId}>
                      <span className="flex items-center justify-between gap-4">
                        <span className="truncate">{sibling.name}</span>
                        <MenuRadioItemIndicator />
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              )}
            </MenuSubPopup>
          </MenuSub>
          <MenuItem
            disabled={!props.canManage}
            onClick={() => {
              afterClose.current = props.onRename;
              keepFocus.current = true;
            }}
          >
            <TextCursorInputIcon aria-hidden />
            Rename
          </MenuItem>
          <MenuItem disabled={!props.canManage} onClick={props.onDuplicate}>
            <CopyPlusIcon aria-hidden />
            Duplicate
          </MenuItem>
          <MenuItem onClick={props.onOpenSettings}>
            <SettingsIcon aria-hidden />
            Open in Settings
          </MenuItem>
          {props.onRescan ? (
            <MenuItem
              disabled={!props.canManage || props.rescanning === true}
              onClick={props.onRescan}
            >
              <RefreshCwIcon
                aria-hidden
                className={props.rescanning ? "animate-spin" : undefined}
              />
              {props.rescanning ? "Rescanning…" : "Rescan"}
            </MenuItem>
          ) : null}
          {props.storage !== null && props.onStorage ? (
            <MenuItem onClick={props.onStorage}>
              <HardDriveIcon aria-hidden />
              <span className="flex flex-1 items-center justify-between gap-4">
                Storage
                <span className="text-muted-foreground text-xs tabular-nums">
                  {formatBytes(props.storage.usedBytes)}
                </span>
              </span>
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem
            variant="destructive"
            disabled={!props.canManage}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
          >
            <Trash2Icon aria-hidden />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
      <AlertDialog open={confirming} onOpenChange={(open) => !busy && setConfirming(open)}>
        <AlertDialogPopup data-testid="system-delete-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{system.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteWarning(system, props.usage, props.ownerLabel)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error !== null ? (
            <p role="alert" className="px-6 text-destructive-foreground text-sm">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              data-testid="system-delete-confirm"
              onClick={() => {
                setBusy(true);
                setError(null);
                void props.onDelete().then((problem) => {
                  setBusy(false);
                  if (problem === null) setConfirming(false);
                  else setError(problem);
                });
              }}
            >
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
