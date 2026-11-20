import { useState } from "react";

import { useTx } from "../../i18n";
import { IPHONE_PROVEN_EXAMPLES } from "../../onboarding/iphoneExamples";
import { useComputerUsePermissions } from "../computerUse/ComputerUsePermissions";
import type { AccessRowOpen } from "./AccessStep";
import { AccessRow, AccessRowAction, AccessRowChip, PhoneRowGlyph } from "./AccessRow";

/** Apple's iPhone Mirroring support page, the source of the limits below (read November 19, 2026). */
export const IPHONE_MIRRORING_SUPPORT_URL = "https://support.apple.com/en-us/120421";

export type IPhoneRowState = "needs-mac-apps" | "ready" | "could-not-check";

/**
 * The row has no grant of its own: it is ready once Mac apps are allowed. A
 * failed check wins, as in the Mac apps row, since the last answer may be stale.
 */
export function iphoneRowState({
  status,
  error,
}: {
  readonly status: { readonly screenRecording: boolean; readonly accessibility: boolean };
  readonly error: string | null;
}): IPhoneRowState {
  if (error !== null) return "could-not-check";
  return status.screenRecording && status.accessibility ? "ready" : "needs-mac-apps";
}

/** Opens Apple's iPhone Mirroring app; the desktop call takes no argument. */
export function openIphoneMirroring(): Promise<boolean> {
  const open =
    typeof window === "undefined" ? undefined : window.desktopBridge?.openIphoneMirroring;
  return open === undefined ? Promise.resolve(false) : open().catch(() => false);
}

/** The row as drawn, so a fixture can draw both states. */
export function IPhoneRowView({
  state,
  open,
  onOpenChange,
  onOpenMirroring,
  onRetry,
  openFailed = false,
  examples,
}: AccessRowOpen & {
  readonly state: IPhoneRowState;
  readonly onOpenMirroring: () => void;
  /** Checks the Mac's permissions again, after a failed check. */
  readonly onRetry: () => void;
  /** The last Open iPhone Mirroring press could not open it. */
  readonly openFailed?: boolean;
  /** The proven examples, listed under "Tried with". */
  readonly examples: readonly string[];
}) {
  const tx = useTx();
  const actions = (
    <>
      {state === "could-not-check" ? (
        <>
          <span hidden data-iphone-state={state} />
          <AccessRowAction onClick={onRetry}>{tx("Retry")}</AccessRowAction>
        </>
      ) : (
        <AccessRowChip on={state === "ready"}>
          <span data-iphone-state={state}>
            {state === "ready" ? tx("Ready to try") : tx("Needs Mac apps first")}
          </span>
        </AccessRowChip>
      )}
      <AccessRowAction
        expands={{ row: "iphone", open }}
        onClick={() => onOpenChange(!open)}
        data-access-focus="iphone-toggle"
      >
        {open ? tx("Hide") : tx("Show")}
      </AccessRowAction>
    </>
  );
  return (
    <AccessRow
      id="iphone"
      glyph={<PhoneRowGlyph />}
      title={tx("Your iPhone")}
      state={
        <>
          <span className="block">
            {tx("Agents can work in apps on your iPhone through iPhone Mirroring.")}
          </span>
          {state === "could-not-check" ? (
            <span className="block">{tx("Could not check the Mac's permissions.")}</span>
          ) : null}
        </>
      }
      actions={actions}
      open={open}
    >
      <div className="grid gap-2.5">
        <div>
          <AccessRowAction onClick={() => onOpenMirroring()}>
            {tx("Open iPhone Mirroring")}
          </AccessRowAction>
          {openFailed ? (
            <span role="alert" className="mt-1 block text-destructive-foreground">
              {tx("Could not open iPhone Mirroring. Open it from the Applications folder.")}
            </span>
          ) : null}
        </div>
        <ol className="list-decimal space-y-0.5 ps-5">
          <li>{tx("Open iPhone Mirroring and enter your iPhone's passcode once.")}</li>
          <li>{tx("Allow Mac apps above.")}</li>
          <li>
            {tx("Ask an agent, and approve the access card for iPhone Mirroring the first time.")}
          </li>
        </ol>
        {examples.length > 0 ? (
          <div>
            <h3 className="font-medium">{tx("Tried with")}</h3>
            <ul className="list-disc space-y-0.5 ps-5" data-iphone-examples="">
              {examples.map((example) => (
                <li key={example}>{tx(example)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <p>{tx("Tell the agent where to stop. These examples do.")}</p>
        <div>
          <h3 className="font-medium">{tx("Limits")}</h3>
          <ul className="list-disc space-y-0.5 ps-5 text-muted-foreground">
            <li>{tx("One Mac and one iPhone at a time.")}</li>
            <li>{tx("Not available in the EU.")}</li>
            <li>
              {tx(
                "The iPhone's camera and microphone do not work while mirrored, Face ID included.",
              )}
            </li>
            <li>
              {tx(
                "It pauses after a while with no activity, and stops when the iPhone is unlocked.",
              )}
            </li>
            <li>{tx("Latin text only.")}</li>
            <li>{tx("It pauses when you pick the phone up.")}</li>
          </ul>
          <a
            className="mt-1 inline-block underline underline-offset-2"
            href={IPHONE_MIRRORING_SUPPORT_URL}
            target="_blank"
            rel="noreferrer"
          >
            {tx("Apple's iPhone Mirroring page")}
          </a>
        </div>
      </div>
    </AccessRow>
  );
}

/**
 * First-run's "Your iPhone" row: how an agent works in iPhone apps through
 * iPhone Mirroring. It shows only while `accessRows` lists it: on this Mac,
 * with iPhone Mirroring installed and at least one proven example (1395 D-02).
 */
export function IPhoneRow({ open, onOpenChange }: AccessRowOpen) {
  const permissions = useComputerUsePermissions();
  const [openFailed, setOpenFailed] = useState(false);
  const openMirroring = () => {
    setOpenFailed(false);
    void openIphoneMirroring().then((opened) => setOpenFailed(!opened));
  };
  return (
    <IPhoneRowView
      state={iphoneRowState(permissions)}
      open={open}
      onOpenChange={onOpenChange}
      onOpenMirroring={openMirroring}
      onRetry={permissions.retry}
      openFailed={openFailed}
      examples={IPHONE_PROVEN_EXAMPLES}
    />
  );
}
