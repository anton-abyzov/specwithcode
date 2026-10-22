import type {
  DesignAccessLevel,
  DesignDocument,
  DesignOperation,
} from "@specweave-studio/contracts";
import { designAccess, designBoundThread } from "@specweave-studio/shared/designOps";
import { BotIcon, CopyIcon, LaptopIcon, MonitorSmartphoneIcon } from "lucide-react";
import type { ReactNode } from "react";
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
import type { DesignShareInfo } from "./backend";

const LEVELS: readonly { value: DesignAccessLevel; label: string }[] = [
  { value: "edit", label: "Can edit" },
  { value: "comment", label: "Can comment" },
  { value: "view", label: "Can view" },
];

/**
 * Who can reach this design and what they may do. The app has no public web
 * links, so the dialog says so instead of offering one.
 */
export function ShareDialog({
  open,
  onOpenChange,
  document,
  share,
  canChangeAccess,
  onCommit,
  exportActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  document: DesignDocument;
  share: DesignShareInfo;
  canChangeAccess: boolean;
  onCommit: (operations: DesignOperation[]) => void;
  exportActions: ReactNode;
}) {
  const access = designAccess(document);
  const thread = designBoundThread(document);
  const others = [...share.devices, ...share.machines];
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(share.link);
      toastManager.add({
        type: "success",
        title: "Link copied",
        description: "It opens this design in the app on your devices and linked machines.",
      });
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not copy the link",
        description: share.link,
      });
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>Share {document.title || "design"}</DialogTitle>
          <DialogDescription>
            Owned by {share.ownerLabel}. People and agents below reach it through the app.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <ul className="flex flex-col gap-1" aria-label="Who has access">
              <AccessRow icon={<LaptopIcon />} title={`You on ${share.thisMachine}`} detail="Owner">
                <span className="text-xs text-muted-foreground">Can edit</span>
              </AccessRow>
              <AccessRow
                icon={<MonitorSmartphoneIcon />}
                title="Your devices and linked machines"
                detail={others.length === 0 ? "None paired or linked yet" : others.join(", ")}
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
                  thread === null
                    ? "Through the design tools; no thread is bound yet"
                    : "Through the design tools, including the bound thread"
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
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void copyLink()}>
                <CopyIcon />
                Copy link
              </Button>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {share.link}
              </span>
            </div>
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              Public web links are not available in this build. To send the design to someone
              outside your devices, export it.
            </p>
            <div className="flex flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Export</h3>
              <div className="flex flex-wrap gap-1.5">{exportActions}</div>
            </div>
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
  detail: string;
  children: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 rounded-md px-1 py-1.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {children}
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
      <SelectTrigger size="xs" className="w-32" aria-label={`${label} access`}>
        <SelectValue>
          {(current: string) => LEVELS.find((level) => level.value === current)?.label ?? current}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {LEVELS.map((level) => (
          <SelectItem key={level.value} value={level.value}>
            {level.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
