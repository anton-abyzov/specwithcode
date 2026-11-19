/**
 * What the owner and a waiting device see (1327). Views take plain props so the
 * hosts and the fixture under tests/device-approval render the same thing.
 */
import { CircleCheckIcon, MonitorSmartphoneIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import {
  type ConnectDevice,
  type ConnectDeviceRequest,
  type ConnectDevicesSnapshot,
  approverName,
  connectDeviceDetails,
  connectDeviceIdLabel,
  connectDeviceName,
  connectDeviceTitle,
  isCompleteApprovalCode,
  longDate,
} from "../../studio/connectDevices.logic";
import { useLocale, useTx } from "../../i18n";
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
import { CopyCodeButton, DeviceApprovalCode, OwnDeviceIdLine } from "./inlineApprovalCode";

/** Resolves to an error to show, or null when the code was accepted. */
export type ApproveWithCode = (code: string) => Promise<string | null>;

function CodeForm({
  id,
  label,
  onApprove,
  disabled = false,
  autoFocus = false,
  compact = false,
}: {
  id: string;
  label: string;
  onApprove: ApproveWithCode;
  /** True while a Deny beside it runs, so Allow and Deny never overlap. */
  disabled?: boolean;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const tx = useTx();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  const allow = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCompleteApprovalCode(code) || busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const problem = await onApprove(code);
      if (problem) setError(problem);
      else setCode("");
    } finally {
      setBusy(false);
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
          className={compact ? "w-36" : undefined}
          font="mono"
          size={compact ? "sm" : "lg"}
          maxLength={9}
          onChange={(event) => {
            // In capitals, like the code on the device; the machine accepts any case (1416).
            setCode(event.target.value.toUpperCase());
            setError(null);
          }}
          placeholder={tx("6 characters")}
          spellCheck={false}
          value={code}
        />
        <div className="flex gap-2">
          <Button
            type="submit"
            size={compact ? "xs" : "default"}
            disabled={!isCompleteApprovalCode(code) || busy || disabled}
          >
            {busy ? tx("Allowing…") : tx("Allow")}
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

/** "ID 7K3Q" beside a name, set apart so two devices of one name read differently (1406). */
function ShortId({ device }: { device: { readonly shortId?: string | undefined } }) {
  const tx = useTx();
  const label = connectDeviceIdLabel(device, tx);
  if (!label) return null;
  return (
    <span
      className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-xs font-normal text-muted-foreground"
      data-device-short-id={device.shortId}
    >
      {label}
    </span>
  );
}

/**
 * One Allow or Deny at a time for a list of waiting devices: while one runs,
 * the code box and every Deny wait, so two answers never cross.
 */
function useOneAtATime() {
  const [running, setRunning] = useState(false);
  const run = async <A,>(action: () => Promise<A>): Promise<A> => {
    setRunning(true);
    try {
      return await action();
    } finally {
      setRunning(false);
    }
  };
  return { running, run };
}

/** One waiting device's own Deny: it acts on the row it sits in and says which. */
function DenyButton({
  request,
  disabled,
  onDeny,
}: {
  request: ConnectDeviceRequest;
  disabled: boolean;
  onDeny: (requestId: string) => Promise<void>;
}) {
  const tx = useTx();
  const [busy, setBusy] = useState(false);
  const deny = async () => {
    setBusy(true);
    try {
      await onDeny(request.id);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={disabled || busy}
      aria-label={tx("Deny {device}", { device: connectDeviceTitle(request, tx) })}
      data-device-deny={request.id}
      onClick={() => void deny()}
    >
      {busy ? tx("Turning away…") : tx("Deny")}
    </Button>
  );
}

const NONE_ALLOWED: ReadonlyArray<ConnectDevice> = [];

/**
 * Opens on its own on the machine when a device asks; never needs Settings to
 * find. It lists every waiting device, because the typed code picks the device
 * whichever one is on screen (1406): two phones of one name are told apart by
 * their IDs, and the device just allowed is named while others still wait.
 */
export function DeviceApprovalPrompt({
  machine,
  account = null,
  hubName,
  requests,
  allowed = NONE_ALLOWED,
  onApprove,
  onDeny,
  onLater,
}: {
  machine: string;
  /** The SpecWithCode Connect account the devices signed in with, when known here. */
  account?: string | null;
  /** For a phone: the hub machine it was paired through, by the name this app knows it under. */
  hubName?: ((environmentId: string) => string | null) | undefined;
  requests: ReadonlyArray<ConnectDeviceRequest>;
  /** Devices allowed since this pop-up opened. */
  allowed?: ReadonlyArray<ConnectDevice>;
  onApprove: ApproveWithCode;
  onDeny: (requestId: string) => Promise<void>;
  onLater: () => void;
}) {
  const tx = useTx();
  const answer = useOneAtATime();
  const only = requests.length === 1 ? requests[0]! : null;
  if (requests.length === 0) return null;
  const hubOf = (request: ConnectDeviceRequest) =>
    request.via === undefined ? null : (hubName?.(request.via) ?? null);
  const waitingCount =
    requests.length === 1
      ? tx("1 device waiting")
      : tx("{count} devices waiting", { count: requests.length });
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onLater())}>
      <DialogPopup
        className="max-w-md"
        data-device-approval-prompt={requests.map((request) => request.id).join(" ")}
      >
        <DialogHeader>
          <DialogTitle>
            {only
              ? tx("A new device wants to use {machine}", { machine })
              : tx("{count} devices want to use {machine}", { count: requests.length, machine })}
          </DialogTitle>
          <DialogDescription data-device-approval-line>
            {only === null
              ? tx("Each one shows its own code. Type the code from the device you want to allow.")
              : only.kind === "connect" && account
                ? tx("{device} is asking. It signed in to SpecWithCode Connect as {account}.", {
                    device: connectDeviceName(only, tx),
                    account,
                  })
                : only.kind === "connect"
                  ? tx("{device} is asking. It signed in to your SpecWithCode Connect account.", {
                      device: connectDeviceName(only, tx),
                    })
                  : hubOf(only)
                    ? tx("{device} is asking. It was paired through {hub}.", {
                        device: connectDeviceName(only, tx),
                        hub: hubOf(only)!,
                      })
                    : tx("{device} is asking. It was paired through another of your machines.", {
                        device: connectDeviceName(only, tx),
                      })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {allowed.map((device) => (
            <p
              key={device.key}
              role="status"
              className="flex items-start gap-2 text-sm text-success-foreground"
              data-device-approval-allowed={device.shortId ?? ""}
            >
              <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {tx("Allowed {device}. It can now use {machine}.", {
                  device: connectDeviceTitle(device, tx),
                  machine,
                })}
              </span>
            </p>
          ))}
          <ul
            className="divide-y divide-border/60 rounded-lg border border-border"
            data-device-approval-waiting={requests.length}
          >
            {requests.map((request) => {
              const details = connectDeviceDetails(request, tx);
              const hub = hubOf(request);
              return (
                <li
                  key={request.id}
                  className="flex items-start gap-3 px-3 py-2.5"
                  data-device-approval-row={request.id}
                >
                  <MonitorSmartphoneIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span className="truncate">{connectDeviceName(request, tx)}</span>
                      <ShortId device={request} />
                    </p>
                    {details ? (
                      <p className="text-xs text-muted-foreground" data-device-approval-details>
                        {details}
                      </p>
                    ) : null}
                    {only ? null : (
                      <p className="text-xs text-muted-foreground" data-device-approval-source>
                        {request.kind === "connect"
                          ? account
                            ? tx("Signed in to SpecWithCode Connect as {account}", { account })
                            : tx("Signed in to your SpecWithCode Connect account")
                          : hub
                            ? tx("Paired through {hub}", { hub })
                            : tx("Paired through another of your machines")}
                      </p>
                    )}
                  </div>
                  <DenyButton
                    request={request}
                    disabled={answer.running}
                    onDeny={(id) => answer.run(() => onDeny(id))}
                  />
                </li>
              );
            })}
          </ul>
          <p className="text-sm" data-device-approval-grants>
            {tx(
              "Allow lets that device's SpecWithCode app open {machine} and do what this app can here: chats, terminals, files, settings and sign-ins. Letting another machine's agents run work here is a separate choice.",
              { machine },
            )}
          </p>
          <p className="text-xs text-muted-foreground" data-device-approval-provenance>
            {tx(
              "The name is what the device calls itself. The code is what proves it is the device in front of you, so allow only a code you can read on it.",
            )}
          </p>
          <CodeForm
            id="prompt"
            label={
              only
                ? tx("Type the code shown on {device}", { device: connectDeviceName(only, tx) })
                : tx("Type the code shown on the device you want to allow")
            }
            onApprove={(code) => answer.run(() => onApprove(code))}
            disabled={answer.running}
            autoFocus
          />
        </DialogPanel>
        <DialogFooter className="items-center sm:justify-between">
          <span className="text-xs text-muted-foreground" data-device-approval-count>
            {only && allowed.length === 0
              ? tx("Deny turns it away for a day.")
              : `${waitingCount} · ${tx("Deny turns it away for a day.")}`}
          </span>
          <Button variant="outline" size="sm" onClick={onLater}>
            {tx("Later")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const WAITING_CARD_CLASS =
  "w-[min(30rem,calc(100vw-2rem))] rounded-2xl border border-border bg-popover p-4 text-popover-foreground shadow-lg";

/**
 * Closes the floating card. The join stays pending: the code is still in
 * Settings > Machines and the sidebar's "Show code" opens the card again.
 */
function WaitingCardClose({ onClose }: { onClose: () => void }) {
  const tx = useTx();
  return (
    <Button
      aria-label={tx("Close")}
      title={tx("Close. The code stays in Settings > Machines.")}
      className="absolute top-2 right-2"
      data-device-waiting-close
      onClick={onClose}
      size="icon-xs"
      variant="ghost-muted"
    >
      <XIcon />
    </Button>
  );
}

/** On the waiting device: where to go and the code to type, large and copyable. */
export function DeviceWaitingCard({
  machine,
  code,
  deviceId = null,
  onClose,
}: {
  machine: string;
  code: string;
  deviceId?: string | null;
  /** Shows a close button; closing only hides the card. */
  onClose?: () => void;
}) {
  return (
    <section
      aria-live="polite"
      data-device-waiting={machine}
      className={onClose ? `relative pr-10 ${WAITING_CARD_CLASS}` : WAITING_CARD_CLASS}
    >
      {onClose ? <WaitingCardClose onClose={onClose} /> : null}
      <DeviceApprovalCode machine={machine} code={code} deviceId={deviceId} />
    </section>
  );
}

/** One machine this device waits on, and the code to type there. */
export interface WaitingOnMachine {
  readonly id: string;
  readonly machine: string;
  readonly code: string;
}

/**
 * On a device that waits on several machines: one card with each machine's own
 * code, so no code is typed on the wrong machine (1406). A machine leaves the
 * list when it lets this device in; one approval never clears another machine.
 */
export function DeviceWaitingList({
  waiting,
  deviceId = null,
  onClose,
}: {
  waiting: ReadonlyArray<WaitingOnMachine>;
  deviceId?: string | null;
  onClose?: () => void;
}) {
  const tx = useTx();
  const first = waiting[0];
  if (first === undefined) return null;
  if (waiting.length === 1)
    return (
      <DeviceWaitingCard
        machine={first.machine}
        code={first.code}
        deviceId={deviceId}
        {...(onClose ? { onClose } : {})}
      />
    );
  return (
    <section
      aria-live="polite"
      data-device-waiting-list={waiting.length}
      className={onClose ? `relative pr-10 ${WAITING_CARD_CLASS}` : WAITING_CARD_CLASS}
    >
      {onClose ? <WaitingCardClose onClose={onClose} /> : null}
      <p className="text-sm font-medium" data-device-waiting-line>
        {tx("Open SpecWithCode on each machine below and type its code:")}
      </p>
      <ul className="mt-3 space-y-2">
        {waiting.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3"
            data-device-waiting={entry.machine}
          >
            <span className="min-w-0 flex-1 truncate text-sm">{entry.machine}</span>
            <output
              className="select-all font-mono text-xl font-semibold tracking-widest"
              data-device-waiting-code
            >
              {entry.code}
            </output>
            <CopyCodeButton code={entry.code} />
          </li>
        ))}
      </ul>
      <OwnDeviceIdLine deviceId={deviceId} />
      <p className="mt-2 text-xs text-muted-foreground">
        {tx("This device connects on its own once a machine allows it.")}
      </p>
    </section>
  );
}

function approvedLine(device: ConnectDevice, tx: ReturnType<typeof useTx>, locale: string) {
  return device.keptByUpdate
    ? tx("Kept by the update. Check this list.")
    : tx("Approved {date} by {approver}", {
        date: longDate(device.approvedAt, locale),
        approver: approverName(device.approvedBy, tx),
      });
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
  const tx = useTx();
  const locale = useLocale();
  const [busy, setBusy] = useState<string | null>(null);
  const act = async <A,>(key: string, action: () => Promise<A>): Promise<A> => {
    setBusy(key);
    try {
      return await action();
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
            {tx(
              "The device list on {machine} is damaged, so other devices are turned away until it is repaired. Repair starts an empty list; devices then ask again with a code.",
              { machine },
            )}
          </p>
          {snapshot.canRepair ? (
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => void act("repair", actions.onRepair)}
            >
              {tx("Repair")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {snapshot.pending.length > 0 ? (
        <div className="space-y-3 px-3 py-3 sm:px-4" data-connect-devices-waiting>
          <p className="text-xs font-medium text-foreground">{tx("Waiting for approval")}</p>
          {snapshot.pending.map((request) => (
            <div
              key={request.id}
              className="flex items-start gap-3"
              data-connect-device-waiting={request.id}
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span>
                    {tx("{device} is waiting to use {machine}.", {
                      device: connectDeviceName(request, tx),
                      machine,
                    })}
                  </span>
                  <ShortId device={request} />
                </p>
                <p className="text-xs text-muted-foreground">{connectDeviceDetails(request, tx)}</p>
              </div>
              {snapshot.canApprove ? (
                <DenyButton
                  request={request}
                  disabled={busy !== null}
                  onDeny={(id) => act("deny", () => actions.onDeny(id))}
                />
              ) : null}
            </div>
          ))}
          {snapshot.canApprove ? (
            <CodeForm
              compact
              id="list"
              label={tx("Type the code shown on the device you want to allow")}
              onApprove={(code) => act("allow", () => actions.onApprove(code))}
              disabled={busy !== null}
            />
          ) : null}
        </div>
      ) : null}
      {snapshot.needsReview ? (
        <div
          className="flex flex-wrap items-center gap-3 px-3 py-3 sm:px-4"
          data-connect-devices-review
        >
          <p className="min-w-0 flex-1 text-sm">
            {tx(
              "These devices were in use when {machine} updated, so they were kept. Remove any you do not know.",
              { machine },
            )}
          </p>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void act("review", actions.onConfirmReview)}
          >
            {tx("The list is right")}
          </Button>
        </div>
      ) : null}
      {snapshot.devices.length === 0 && snapshot.pending.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {tx(
            "No other devices yet. A phone or computer signed in to SpecWithCode Connect asks here first, with a code.",
          )}
        </p>
      ) : null}
      {snapshot.devices.length > 0 ? (
        <p
          className="px-3 pt-3 text-xs font-medium text-foreground sm:px-4"
          data-connect-devices-allowed
        >
          {tx("Allowed")}
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
            <p className="flex items-center gap-2 text-sm">
              <span className="truncate">{connectDeviceName(device, tx)}</span>
              <ShortId device={device} />
            </p>
            {connectDeviceDetails(device, tx, locale) ? (
              <p className="truncate text-xs text-muted-foreground" data-connect-device-details>
                {connectDeviceDetails(device, tx, locale)}
              </p>
            ) : null}
            <p
              className={
                device.keptByUpdate && snapshot.needsReview
                  ? "text-xs text-warning-foreground"
                  : "text-xs text-muted-foreground"
              }
            >
              {device.keptByUpdate && !snapshot.needsReview
                ? tx("Kept by the update")
                : approvedLine(device, tx, locale)}
            </p>
          </div>
          {snapshot.canApprove ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy !== null}
              onClick={() => void act(device.key, () => actions.onRemove(device))}
            >
              {tx("Remove")}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** "1 device waiting" for the section header, so a missed pop-up is still easy to find. */
export function WaitingBadge({ count }: { count: number }) {
  const tx = useTx();
  if (count === 0) return null;
  return (
    <Badge variant="warning" data-connect-devices-waiting-count={count}>
      {count === 1 ? tx("1 device waiting") : tx("{count} devices waiting", { count })}
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
  const tx = useTx();
  if (!supported)
    return (
      <SettingsSection id="connect-devices" title={tx(SECTION_TITLE)}>
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {tx(
            "This machine does not ask before new devices connect yet. Update it to choose which devices can use it.",
          )}
        </p>
      </SettingsSection>
    );
  return (
    <SettingsSection
      id="connect-devices"
      title={tx(SECTION_TITLE)}
      headerAction={<WaitingBadge count={snapshot?.pending.length ?? 0} />}
    >
      {snapshot ? (
        <ConnectDevicesList snapshot={snapshot} actions={actions} />
      ) : (
        <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {error ?? tx("Checking devices…")}
        </p>
      )}
    </SettingsSection>
  );
}
