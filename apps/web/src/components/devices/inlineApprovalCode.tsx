/**
 * The code a waiting device shows inside a join or first-run card (1327).
 * Light on imports, so the cards and their tests do not load the hosts.
 */
import type { EnvironmentId } from "@specweave-studio/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useTx } from "../../i18n";
import { Button } from "../ui/button";
import { useOwnDeviceShortId } from "./ownDeviceId";

/** Copies one code; says so for a moment. */
export function CopyCodeButton({ code }: { code: string }) {
  const tx = useTx();
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
    <Button size="sm" variant="outline" onClick={() => void copy()}>
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? tx("Copied") : tx("Copy")}
    </Button>
  );
}

/**
 * Which device this is, by the four characters the machine shows beside it
 * (1406), so the owner picks the right row among devices of one name.
 */
export function OwnDeviceIdLine({ deviceId }: { deviceId: string | null | undefined }) {
  const tx = useTx();
  if (!deviceId) return null;
  return (
    <p className="mt-2 text-xs text-muted-foreground" data-own-device-id={deviceId}>
      {tx("This device's ID is {id}. The machine shows the same ID next to it.", { id: deviceId })}
    </p>
  );
}

/**
 * Where to go and the code to type, large and copyable: in the floating card,
 * and inline where a join or first run is waiting on that machine (1327).
 */
export function DeviceApprovalCode({
  machine,
  code,
  deviceId = null,
}: {
  machine: string;
  code: string;
  /** This device's own short ID, when it is known. */
  deviceId?: string | null;
}) {
  const tx = useTx();
  return (
    <div data-device-approval-code={machine}>
      <p className="text-sm font-medium" data-device-waiting-line>
        {tx("Open SpecWithCode on {machine} and type this code:", { machine })}
      </p>
      <div className="mt-3 flex items-center gap-3">
        <output
          className="select-all font-mono text-3xl font-semibold tracking-widest"
          data-device-waiting-code
        >
          {code}
        </output>
        <CopyCodeButton code={code} />
      </div>
      <OwnDeviceIdLine deviceId={deviceId} />
      <p className="mt-2 text-xs text-muted-foreground">
        {tx("This device connects on its own once {machine} allows it.", { machine })}
      </p>
    </div>
  );
}

/**
 * The floating card's layer: above dialogs and their backdrop (z-50) and media
 * (z-[60]), below toasts, so the code stays readable while a dialog is open (1416).
 */
export const FLOATING_CODE_LAYER_CLASS =
  "pointer-events-none fixed inset-x-0 top-3 z-[70] flex flex-col items-center gap-2";

/** Machines whose code a join or first-run card already shows, so the floating card stays away. */
const inlineCodes = new Map<string, number>();
const inlineListeners = new Set<() => void>();
let inlineVersion = 0;
export const inlineCodesVersion = () => inlineVersion;
export const inlineCodeShown = (environmentId: string) => inlineCodes.has(environmentId);
export const subscribeInlineCodes = (listener: () => void) => {
  inlineListeners.add(listener);
  return () => inlineListeners.delete(listener);
};
const changeInline = (environmentId: string, by: 1 | -1) => {
  const next = (inlineCodes.get(environmentId) ?? 0) + by;
  if (next > 0) inlineCodes.set(environmentId, next);
  else inlineCodes.delete(environmentId);
  inlineVersion++;
  for (const listener of inlineListeners) listener();
};

/**
 * The code to type on a machine, inside a card that is waiting on it (1327):
 * the join card and first run. The floating card hides that machine meanwhile.
 */
export function InlineDeviceApprovalCode({
  environmentId,
  machine,
  code,
}: {
  environmentId: EnvironmentId;
  machine: string;
  code: string;
}) {
  useEffect(() => {
    changeInline(environmentId, 1);
    return () => changeInline(environmentId, -1);
  }, [environmentId]);
  const deviceId = useOwnDeviceShortId();
  return (
    <div
      role="status"
      className="rounded-lg border border-border bg-muted/40 p-3"
      data-inline-device-approval={environmentId}
    >
      <DeviceApprovalCode machine={machine} code={code} deviceId={deviceId} />
    </div>
  );
}
