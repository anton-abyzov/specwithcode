import type {
  DesignAccessLevel,
  DesignDocument,
  DesignOperation,
} from "@specweave-studio/contracts";
import { designAccess, designBoundThread } from "@specweave-studio/shared/designOps";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  BotIcon,
  CheckIcon,
  CodeXmlIcon,
  FileTextIcon,
  ImageIcon,
  LaptopIcon,
  LinkIcon,
  MonitorSmartphoneIcon,
  PenToolIcon,
  PresentationIcon,
  ShapesIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { ProjectFavicon } from "~/components/ProjectFavicon";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { designLinkReach } from "../gallery/designLinks";
import type { DesignExportRequest, DesignShareInfo } from "./backend";
import { ownerLinks, plainClick } from "./ownerLinks";

const LEVELS: readonly { value: DesignAccessLevel; label: string; detail: string }[] = [
  { value: "edit", label: "Can edit", detail: "Change frames and text" },
  { value: "comment", label: "Can comment", detail: "Leave notes, no edits" },
  { value: "view", label: "Can view", detail: "Open and export only" },
];

/** Devices listed before the rest fold into "+N more". */
const DEVICES_SHOWN = 3;

export interface ShareExport {
  readonly format: DesignExportRequest["format"];
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => Promise<void>;
}

const EXPORT_ICONS: Record<DesignExportRequest["format"], ReactNode> = {
  png: <ImageIcon aria-hidden />,
  html: <CodeXmlIcon aria-hidden />,
  pdf: <FileTextIcon aria-hidden />,
  pptx: <PresentationIcon aria-hidden />,
  svg: <PenToolIcon aria-hidden />,
};

/**
 * Who can reach this design and what they may do, how to send it to someone,
 * and how to export it. The owner chip goes back to the owning project's
 * Designs tab. The app has no public web links, so the dialog says so in one
 * line instead of offering one.
 */
export function ShareDialog({
  open,
  onOpenChange,
  document,
  share,
  canChangeAccess,
  onCommit,
  exports,
  threadTitle = null,
  onOpenThread = null,
  onStartThread = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: DesignDocument;
  share: DesignShareInfo;
  canChangeAccess: boolean;
  onCommit: (operations: DesignOperation[]) => void;
  exports: readonly ShareExport[];
  /** The bound thread's title; null when no thread is bound. */
  threadTitle?: string | null;
  onOpenThread?: (() => void) | null;
  onStartThread?: (() => void) | null;
}) {
  const router = useRouter();
  const access = designAccess(document);
  const thread = designBoundThread(document);
  const others = [...share.devices, ...share.machines];
  const owner = share.ownerProject ?? null;
  const links = ownerLinks(share);
  const [exporting, setExporting] = useState<ShareExport["format"] | null>(null);
  const reach = designLinkReach(share.link);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(share.link);
      toastManager.add({
        type: "success",
        title: "Link copied",
        description: reach.text,
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not copy the link",
        description: "Your browser blocked the clipboard. Try again from the app.",
      });
    }
  };
  const runExport = async (item: ShareExport) => {
    setExporting(item.format);
    try {
      await item.run();
    } finally {
      setExporting(null);
    }
  };
  const shownDevices = others.slice(0, DEVICES_SHOWN);
  const hiddenDevices = others.slice(DEVICES_SHOWN);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="max-w-[520px] bg-popover [backdrop-filter:none] [-webkit-backdrop-filter:none]"
        data-testid="share-dialog"
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="line-clamp-2 text-[15px] leading-snug font-semibold text-balance">
            Share {document.title || "design"}
          </DialogTitle>
          <DialogDescription render={<div />} className="flex flex-wrap items-center gap-2">
            {owner !== null && links.project !== null ? (
              <a
                href={links.project.href}
                data-testid="share-owner"
                className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full bg-foreground/5 pr-2 pl-1.5 text-xs font-medium text-foreground/80 outline-none transition-colors duration-[120ms] ease-out-quint hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                onClick={(event) => {
                  if (!plainClick(event)) return;
                  event.preventDefault();
                  onOpenChange(false);
                  void router.navigate(links.project!.route as never);
                }}
              >
                {owner.icon ? (
                  <ProjectFavicon project={owner.icon} className="size-3.5 shrink-0" />
                ) : null}
                <span className="truncate">{owner.label}</span>
                <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 opacity-70" />
                <span className="sr-only">: open the project's designs</span>
              </a>
            ) : (
              <span
                data-testid="share-owner"
                className="inline-flex h-6 items-center gap-1.5 rounded-full bg-foreground/5 pr-2 pl-1.5 text-xs font-medium text-foreground/80"
              >
                {owner === null ? <ShapesIcon aria-hidden className="size-3.5 shrink-0" /> : null}
                {owner?.label ?? "Playground"}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col divide-y divide-border/60">
            <section className="flex flex-col gap-1 pb-4" aria-labelledby="share-who">
              <h3 id="share-who" className="pb-1 text-xs font-semibold text-foreground/80">
                Who can open this
              </h3>
              <ul className="flex flex-col gap-1" aria-label="Who has access">
                <AccessRow
                  icon={<LaptopIcon />}
                  title={`You on ${share.thisMachine}`}
                  detail="Owner · full access"
                >
                  <span className="inline-flex h-6 items-center rounded-md bg-foreground/5 px-2 text-xs font-medium text-foreground/70">
                    Owner
                  </span>
                </AccessRow>
                <AccessRow
                  icon={<MonitorSmartphoneIcon />}
                  title="Your devices and linked machines"
                  detail={
                    others.length === 0 ? (
                      "None paired or linked yet"
                    ) : (
                      <>
                        {shownDevices.join(", ")}
                        {hiddenDevices.length > 0 ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="ml-1 rounded-sm font-medium text-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                />
                              }
                            >
                              +{hiddenDevices.length} more
                            </TooltipTrigger>
                            <TooltipPopup side="bottom">{hiddenDevices.join(", ")}</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </>
                    )
                  }
                >
                  <LevelSelect
                    label="Devices and linked machines"
                    value={access.members}
                    disabled={!canChangeAccess}
                    onChange={(members) => onCommit([{ op: "set_access", members }])}
                  />
                </AccessRow>
                <AccessRow
                  icon={<BotIcon />}
                  title="Agent threads"
                  detail={
                    thread !== null ? (
                      <>
                        Bound to{" "}
                        {onOpenThread ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-0.5 rounded-sm font-medium text-foreground/80 italic outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => {
                              onOpenChange(false);
                              onOpenThread();
                            }}
                          >
                            {threadTitle ?? "the design thread"}
                            <ArrowUpRightIcon aria-hidden className="size-3" />
                          </button>
                        ) : (
                          <em>{threadTitle ?? "the design thread"}</em>
                        )}
                      </>
                    ) : (
                      <>
                        No thread bound yet
                        {onStartThread ? (
                          <>
                            {" · "}
                            <button
                              type="button"
                              className="rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                              onClick={onStartThread}
                            >
                              Start one
                            </button>
                          </>
                        ) : null}
                      </>
                    )
                  }
                >
                  <LevelSelect
                    label="Agent threads"
                    value={access.agents}
                    disabled={!canChangeAccess}
                    onChange={(agents) => onCommit([{ op: "set_access", agents }])}
                  />
                </AccessRow>
              </ul>
            </section>
            <section className="py-4">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      className="w-full"
                      data-testid="share-copy-link"
                      onClick={() => void copyLink()}
                    />
                  }
                >
                  <LinkIcon />
                  Copy link
                </TooltipTrigger>
                <TooltipPopup side="bottom" className="max-w-sm break-all">
                  {share.link}
                </TooltipPopup>
              </Tooltip>
              {reach.loopback ? (
                <p className="mt-2 text-muted-foreground text-xs" data-testid="share-link-reach">
                  {reach.text}
                </p>
              ) : null}
            </section>
            <section className="flex flex-col gap-2 pt-4" aria-labelledby="share-export">
              <h3 id="share-export" className="text-xs font-semibold text-foreground/80">
                Export
              </h3>
              <div className={cn("grid gap-2", exports.length > 3 ? "grid-cols-4" : "grid-cols-3")}>
                {exports.map((item) => (
                  <Button
                    key={item.format}
                    variant="outline"
                    size="sm"
                    className="h-8 min-w-0"
                    data-testid="share-export"
                    data-format={item.format}
                    aria-busy={exporting === item.format}
                    disabled={item.disabled || exporting !== null}
                    onClick={() => void runExport(item)}
                  >
                    {EXPORT_ICONS[item.format]}
                    <span className="truncate">
                      {exporting === item.format ? "Exporting…" : item.label}
                    </span>
                  </Button>
                ))}
              </div>
              <p className="pt-1 text-xs text-muted-foreground">
                Public web links aren't available in this build yet.
              </p>
            </section>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function AccessRow({
  icon,
  title,
  detail,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail: ReactNode;
  children: ReactNode;
}) {
  return (
    <li
      className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-start gap-x-3 rounded-md px-1 py-2"
      data-share-row
    >
      <span className="grid size-8 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 pt-0.5">
        <span className="text-sm leading-5 text-pretty">{title}</span>
        <span className="line-clamp-2 text-xs leading-4 text-muted-foreground">{detail}</span>
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

function LevelSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: DesignAccessLevel;
  disabled: boolean;
  onChange: (value: DesignAccessLevel) => void;
}) {
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) =>
        next !== null && next !== value && onChange(next as DesignAccessLevel)
      }
    >
      <SelectTrigger size="xs" className="min-w-36" aria-label={`${label} access`}>
        <SelectValue>
          {(current: string) => LEVELS.find((level) => level.value === current)?.label ?? current}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} align="end" className="min-w-56">
        {LEVELS.map((level) => (
          <SelectItem key={level.value} value={level.value} className="py-1.5">
            <span className="flex items-start gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm font-medium">{level.label}</span>
                <span className="text-xs text-muted-foreground">{level.detail}</span>
              </span>
              <CheckIcon
                aria-hidden
                className={cn(
                  "mt-0.5 size-4 shrink-0 text-foreground",
                  level.value === value ? "opacity-100" : "opacity-0",
                )}
              />
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
