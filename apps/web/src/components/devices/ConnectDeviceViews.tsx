/**
 * What the owner and a waiting device see (1327). Views take plain props so the
 * hosts and the fixture under tests/device-approval render the same thing.
 */
import { CheckIcon, CopyIcon, MonitorSmartphoneIcon, ShieldAlertIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type ConnectDevice,
  type ConnectDeviceRequest,
  type ConnectDevicesSnapshot,
  describeConnectDevice,
  isCompleteApprovalCode,
} from "../../studio/connectDevices.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SettingsSection } from "../settings/settingsLayout";

/** Resolves to an error to show, or null when the code was accepted. */
export type ApproveWithCode = (code: string) => Promise<string | null>;

function CodeForm({
  id,
  label,
  onApprove,
  onDeny,
  autoFocus = false,
  compact = false,
}: {
  id: string;
  label: string;
  onApprove: ApproveWithCode;
  onDeny: () => Promise<void>;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const allow = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCompleteApprovalCode(code) || busy) return;
    setBusy("allow");
    setError(null);
    try {
      const problem = await onApprove(code);
      if (problem) setError(problem);
      else setCode("");
    } finally {
      setBusy(null);
    }
  };
  const deny = async () => {
    setBusy("deny");
    setError(null);
    try {
      await onDeny();
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="space-y-2" onSubmit={(event) => void allow(event)} data-device-code-form={id}>
      <label className="block text-sm font-medium" htmlFor={`device-code-${id}`}>
        {label}
      </label>
      <div className={compact ? "flex flex-wrap gap-2" : "space-y-3"}>
        <Input
          ref={input}
          id={`device-code-${id}`}
          aria-invalid={error ? true : undefined}
          autoCapitalize="characters"
          autoComplete="off"
          className={
            compact
              ? "w-36 font-mono uppercase tracking-[0.2em]"
              : "font-mono text-lg uppercase tracking-[0.3em]"
          }
          maxLength={9}
          onChange={(event) => {
            setCode(event.target.value);
            setError(null);
          }}
          placeholder="K7QX2M"
          spellCheck={false}
          value={code}
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            size={compact ? "xs" : "default"}
            disabled={!isCompleteApprovalCode(code) || busy !== null}
          >
            {busy === "allow" ? "Allowing…" : "Allow"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size={compact ? "xs" : "default"}
            disabled={busy !== null}
            onClick={() => void deny()}
          >
            {busy === "deny" ? "Turning away…" : "Deny"}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </form>
  );
}

/** Opens on its own on the machine when a device asks; never needs Settings to find. */
export function DeviceApprovalPrompt({
  machine,
  request,
  position,
  total,
  onApprove,
  onDeny,
  onLater,
}: {
  machine: string;
  request: ConnectDeviceRequest;
  position: number;
  total: number;
  onApprove: ApproveWithCode;
  onDeny: () => Promise<void>;
  onLater: () => void;
}) {
  const who = describeConnectDevice(request);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onLater())}>
      <DialogPopup className="max-w-md" data-device-approval-prompt={request.id}>
        <DialogHeader>
          <DialogTitle>A new device wants to use {machine}</DialogTitle>
          <DialogDescription data-device-approval-line>
            {who} is asking. Allow lets it use {machine} like this app does.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <CodeForm
            key={request.id}
            id={request.id}
            label={`Type the code shown on ${request.label}`}
            onApprove={onApprove}
            onDeny={onDeny}
            autoFocus
          />
        </DialogPanel>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {total > 1 ? `${position} of ${total} waiting` : "Deny turns it away for a day."}
          </span>
          <Button variant="ghost" size="sm" onClick={onLater}>
            Later
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** On the waiting device: where to go and the code to type, large and copyable. */
export function DeviceWaitingCard({ machine, code }: { machine: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <section
      aria-live="polite"
      data-device-waiting={machine}
      className="w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <p className="text-sm font-medium" data-device-waiting-line>
        Open SpecWithCode on {machine} and type this code:
      </p>
      <div className="mt-3 flex items-center gap-3">
        <output
          className="select-all font-mono text-3xl font-semibold tracking-[0.25em]"
          data-device-waiting-code
        >
          {code}
        </output>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        This device connects on its own once {machine} allows it.
      </p>
    </section>
  );
}

function approvedLine(device: ConnectDevice) {
  const when = new Date(device.approvedAt).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  return device.keptByUpdate
    ? "Kept by the update. Check this list."
    : `Approved ${when} by ${device.approvedBy}`;
}

export interface ConnectDevicesListActions {
  readonly onApprove: ApproveWithCode;
  readonly onDeny: (requestId: string) => Promise<void>;
  readonly onRemove: (device: ConnectDevice) => Promise<void>;
  readonly onConfirmReview: () => Promise<void>;
  readonly onRepair: () => Promise<void>;
}

/** Settings > Machines > Devices that can use this machine, without the section frame. */
export function ConnectDevicesList({
  snapshot,
  actions,
}: {
  snapshot: ConnectDevicesSnapshot;
  actions: ConnectDevicesListActions;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  const machine = snapshot.machine;
  return (
    <div className="divide-y divide-border/60" data-connect-devices>
      {snapshot.health === "damaged" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
          <ShieldAlertIcon className="size-4 text-destructive-foreground" />
          <p className="min-w-0 flex-1 text-sm">
            The device list on {machine} is damaged, so other devices are turned away until it is
            repaired. Repair starts an empty list; devices then ask again with a code.
          </p>
          {snapshot.canRepair ? (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void act("repair", actions.onRepair)}
            >
              Repair
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.pending.map((request) => (
        <div
          key={request.id}
          className="px-3 py-3 sm:px-4"
          data-connect-device-waiting={request.id}
        >
          <p className="mb-2 text-sm">
            <span className="font-medium">{describeConnectDevice(request)}</span>{" "}
            <span className="text-muted-foreground">is waiting to use {machine}.</span>
          </p>
          {snapshot.canApprove ? (
            <CodeForm
              compact
              id={request.id}
              label={`Code shown on ${request.label}`}
              onApprove={actions.onApprove}
              onDeny={() => actions.onDeny(request.id)}
            />
          ) : null}
        </div>
      ))}
      {snapshot.needsReview ? (
        <div
          className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4"
          data-connect-devices-review
        >
          <p className="min-w-0 flex-1 text-sm">
            These devices were in use when {machine} updated, so they were kept. Remove any you do
            not know.
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void act("review", actions.onConfirmReview)}
          >
            The list is right
          </Button>
        </div>
      ) : null}
      {snapshot.devices.length === 0 && snapshot.pending.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          No other devices yet. A phone or computer signed in to SpecWithCode Connect asks here
          first, with a code.
        </p>
      ) : null}
      {snapshot.devices.map((device) => (
        <div
          key={device.key}
          className="flex items-center gap-3 px-3 py-2.5 sm:px-4"
          data-connect-device={device.key}
        >
          <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm">{describeConnectDevice(device)}</p>
            <p
              className={
                device.keptByUpdate && snapshot.needsReview
                  ? "text-xs text-warning-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              {device.keptByUpdate && !snapshot.needsReview
                ? "Kept by the update"
                : approvedLine(device)}
            </p>
          </div>
          {snapshot.canApprove ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() => void act(device.key, () => actions.onRemove(device))}
            >
              Remove
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** "1 device waiting" for the section header, so a missed pop-up is still easy to find. */
export function WaitingBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Badge variant="warning" data-connect-devices-waiting-count={count}>
      {count === 1 ? "1 device waiting" : `${count} devices waiting`}
    </Badge>
  );
}

const SECTION_TITLE = "Devices that can use this machine";

/** The Settings > Machines section, given what the machine answered. */
export function ConnectDevicesSectionView({
  supported,
  snapshot,
  error,
  actions,
}: {
  supported: boolean;
  snapshot: ConnectDevicesSnapshot | null;
  error: string | null;
  actions: ConnectDevicesListActions;
}) {
  if (!supported)
    return (
      <SettingsSection id="connect-devices" title={SECTION_TITLE}>
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          This machine does not ask before new devices connect yet. Update it to choose which
          devices can use it.
        </p>
      </SettingsSection>
    );
  return (
    <SettingsSection
      id="connect-devices"
      title={SECTION_TITLE}
      headerAction={<WaitingBadge count={snapshot?.pending.length ?? 0} />}
    >
      {snapshot ? (
        <ConnectDevicesList snapshot={snapshot} actions={actions} />
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {error ?? "Checking devices…"}
        </p>
      )}
    </SettingsSection>
  );
}
