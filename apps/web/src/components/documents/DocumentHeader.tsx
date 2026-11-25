/**
 * The header every live document wears: what kind of document it is, its
 * title, who else is on it, and Comments, Versions and Share. It follows the
 * design studio's header: ghost icon buttons with tooltips, and one filled
 * Share button at the end.
 *
 * Share only says who can open the document today. Nothing here invites
 * anyone or makes a link.
 */
import type { DocumentSessionAccess, DocumentSessionActivity } from "@specweave-studio/contracts";
import {
  BotIcon,
  FileTextIcon,
  HistoryIcon,
  LaptopIcon,
  type LucideIcon,
  MessageSquareIcon,
  PenToolIcon,
  PresentationIcon,
  Share2Icon,
  ShapesIcon,
  TableIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "~/components/ui/tooltip";

import { useTx } from "../../i18n";
import type { PresenceEntry } from "./presence";

export type DocumentKind = "sheet" | "whiteboard" | "doc" | "design" | "page";

const KIND_ICON: Readonly<Record<DocumentKind, LucideIcon>> = {
  sheet: TableIcon,
  whiteboard: PenToolIcon,
  doc: FileTextIcon,
  design: ShapesIcon,
  page: PresentationIcon,
};

/** The most participants drawn before the rest become a count. */
const PRESENCE_SHOWN = 5;
/** The most changes the Versions list shows, newest first. */
const ACTIVITY_SHOWN = 30;

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function HeaderButton(props: {
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onClick?: (() => void) | undefined;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
            data-testid={props.testId}
          >
            {props.children}
          </Button>
        }
      />
      <TooltipPopup>{props.label}</TooltipPopup>
    </Tooltip>
  );
}

export function DocumentHeader(props: {
  readonly kind: DocumentKind;
  readonly title: string;
  /** Everyone on the document, this window included. Empty when the document is not live. */
  readonly presence: ReadonlyArray<PresenceEntry>;
  /** What changed, oldest first. */
  readonly activity: ReadonlyArray<DocumentSessionActivity>;
  /** What this window may do. */
  readonly access: DocumentSessionAccess;
  /** Opens the document's comments; left out where the kind has none yet. */
  readonly onComments?: (() => void) | undefined;
}): ReactNode {
  const tx = useTx();
  const [shareOpen, setShareOpen] = useState(false);
  const kindName: Readonly<Record<DocumentKind, string>> = {
    sheet: tx("Sheet"),
    whiteboard: tx("Whiteboard"),
    doc: tx("Doc"),
    design: tx("Design"),
    page: tx("Page"),
  };
  const KindIcon = KIND_ICON[props.kind];
  const shown = props.presence.slice(0, PRESENCE_SHOWN);
  const hidden = props.presence.length - shown.length;
  const agents = props.presence.filter((entry) => entry.kind === "agent");

  return (
    <TooltipProvider delay={400}>
      <header
        className="flex h-11 min-h-11 shrink-0 items-center gap-1 border-b border-border/70 px-3"
        data-testid="document-header"
        data-document-kind={props.kind}
      >
        <Badge variant="outline" size="sm" data-testid="document-kind">
          <KindIcon aria-hidden />
          {kindName[props.kind]}
        </Badge>
        <h2
          className="ml-1.5 min-w-0 flex-1 truncate font-medium text-foreground text-sm"
          data-testid="document-title"
        >
          {props.title}
        </h2>
        {props.access === "view" ? (
          <Badge variant="secondary" size="sm" data-testid="document-view-only">
            {tx("View only")}
          </Badge>
        ) : null}
        <div
          className="mx-1 flex shrink-0 items-center"
          role="group"
          aria-label={tx("On this document")}
          data-testid="document-presence"
        >
          {shown.map((entry) => (
            <Tooltip key={entry.id}>
              <TooltipTrigger
                render={
                  <span
                    className="document-presence-dot"
                    data-presence-color={entry.color % 8}
                    data-presence-id={entry.id}
                    data-presence-kind={entry.kind}
                    aria-label={entry.name}
                  >
                    {entry.kind === "agent" ? (
                      <BotIcon aria-hidden className="size-3.5" />
                    ) : (
                      initials(entry.name)
                    )}
                  </span>
                }
              />
              <TooltipPopup>
                {entry.viewOnly ? tx("{name} (view only)", { name: entry.name }) : entry.name}
              </TooltipPopup>
            </Tooltip>
          ))}
          {hidden > 0 ? (
            <span
              className="ml-1 text-muted-foreground text-xs"
              data-testid="document-presence-more"
            >
              +{hidden}
            </span>
          ) : null}
        </div>
        <HeaderButton
          label={
            props.onComments ? tx("Comments") : tx("Comments are not on this kind of document yet")
          }
          disabled={props.onComments === undefined}
          onClick={props.onComments}
          testId="document-comments"
        >
          <MessageSquareIcon />
        </HeaderButton>
        <Popover>
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={tx("Version history")}
                      data-testid="document-versions"
                    />
                  }
                />
              }
            >
              <HistoryIcon />
            </TooltipTrigger>
            <TooltipPopup>{tx("Version history")}</TooltipPopup>
          </Tooltip>
          <PopoverPopup align="end" width="md" padding="compact">
            <p className="px-1 pb-1 font-medium text-foreground text-sm">{tx("Version history")}</p>
            <DocumentActivityList activity={props.activity} presence={props.presence} />
          </PopoverPopup>
        </Popover>
        <Button
          size="sm"
          className="ml-1 shrink-0"
          aria-label={tx("Share")}
          onClick={() => setShareOpen(true)}
          data-testid="document-share"
        >
          <Share2Icon />
          <span>{tx("Share")}</span>
        </Button>
      </header>
      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogPopup className="max-w-[520px]" data-testid="document-share-dialog">
          <DialogHeader>
            <DialogTitle>{tx("Who can open this")}</DialogTitle>
            <DialogDescription>
              {tx(
                "This document stays on this machine. Only windows you have approved and your agents can open it.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <DocumentAccessList access={props.access} agents={agents.map((a) => a.name)} />
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </TooltipProvider>
  );
}

/** What changed in the document, newest first. */
export function DocumentActivityList(props: {
  readonly activity: ReadonlyArray<DocumentSessionActivity>;
  readonly presence: ReadonlyArray<PresenceEntry>;
}): ReactNode {
  const tx = useTx();
  const changes = props.activity.slice(-ACTIVITY_SHOWN).toReversed();
  const names = new Map(props.presence.map((entry) => [entry.id, entry.name]));
  const who = (by: DocumentSessionActivity["by"]): string =>
    by.kind === "file"
      ? tx("The file on disk")
      : (names.get(by.id) ?? by.label ?? (by.kind === "agent" ? tx("An agent") : tx("A window")));
  const what = (entry: DocumentSessionActivity): string => {
    if (entry.superseded === true)
      return tx("made an edit that a change at the same time replaced");
    if (entry.cells === 0) return tx("changed the layout");
    const cells =
      entry.cells === 1 && entry.first !== undefined
        ? tx("changed {cell}", { cell: entry.first })
        : tx("changed {count} cells", { count: String(entry.cells) });
    return entry.layout ? tx("{cells} and the layout", { cells }) : cells;
  };
  if (changes.length === 0) {
    return (
      <p className="px-1 py-2 text-muted-foreground text-sm" data-testid="document-activity-empty">
        {tx("No changes since this document was opened.")}
      </p>
    );
  }
  return (
    <ul className="max-h-72 overflow-y-auto" data-testid="document-activity">
      {changes.map((entry) => (
        <li
          key={entry.id}
          className="flex items-baseline gap-2 px-1 py-1 text-sm"
          data-activity-by={entry.by.kind}
        >
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium text-foreground">{who(entry.by)}</span>{" "}
            <span className="text-muted-foreground">{what(entry)}</span>
          </span>
          <time className="shrink-0 text-muted-foreground text-xs" dateTime={entry.at}>
            {new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
          </time>
        </li>
      ))}
    </ul>
  );
}

/** Who can open the document today. Read-only: nothing here changes access. */
export function DocumentAccessList(props: {
  readonly access: DocumentSessionAccess;
  /** The agents on the document now, by name. */
  readonly agents: ReadonlyArray<string>;
}): ReactNode {
  const tx = useTx();
  return (
    <ul className="flex flex-col gap-2" data-testid="document-access">
      <AccessRow
        icon={LaptopIcon}
        name={tx("This window")}
        level={props.access === "edit" ? tx("Can edit") : tx("Can view")}
        id="self"
      />
      <AccessRow
        icon={LaptopIcon}
        name={tx("Your other approved windows")}
        level={tx("As each was approved")}
        id="windows"
      />
      <AccessRow
        icon={BotIcon}
        name={
          props.agents.length > 0
            ? tx("Your agents ({names})", { names: props.agents.join(", ") })
            : tx("Your agents on this machine")
        }
        level={tx("Can edit")}
        id="agents"
      />
    </ul>
  );
}

function AccessRow(props: {
  readonly icon: LucideIcon;
  readonly name: string;
  readonly level: string;
  readonly id: string;
}): ReactNode {
  const Icon = props.icon;
  return (
    <li className="flex items-center gap-3 text-sm" data-access-row={props.id}>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-foreground">{props.name}</span>
      <span className="shrink-0 text-muted-foreground">{props.level}</span>
    </li>
  );
}
