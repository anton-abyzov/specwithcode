import type { ComputerUsePermissions } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

import { useTx } from "../../i18n";
import {
  COMPUTER_USE_PERMISSION_COPY,
  ComputerUsePermissionChecklist,
  useComputerUsePermissions,
} from "../computerUse/ComputerUsePermissions";
import type { AccessRowOpen } from "./AccessStep";
import { AccessRow, AccessRowAction, AccessRowChip, MacAppsRowGlyph } from "./AccessRow";

export type MacAppsRowStateKind =
  | "allowed"
  | "partly"
  | "not-allowed"
  | "needs-reopening"
  | "could-not-check";

export interface MacAppsRowState {
  readonly kind: MacAppsRowStateKind;
  /** The permission still off, for Partly allowed. */
  readonly missing: string | null;
}

/**
 * The Mac apps row's state, from the shared permission poll. A failed check
 * wins, since the last answer may be stale. Screen Recording asked for and
 * still off is the case macOS applies only after the app reopens.
 */
export function macAppsRowState({
  status,
  error,
  screenRecordingRequested,
}: {
  readonly status: ComputerUsePermissions;
  readonly error: string | null;
  readonly screenRecordingRequested: boolean;
}): MacAppsRowState {
  if (error !== null) return { kind: "could-not-check", missing: null };
  if (status.screenRecording && status.accessibility) return { kind: "allowed", missing: null };
  if (!status.screenRecording && screenRecordingRequested)
    return { kind: "needs-reopening", missing: null };
  if (status.screenRecording !== status.accessibility)
    return {
      kind: "partly",
      missing: status.screenRecording
        ? COMPUTER_USE_PERMISSION_COPY.accessibility.title
        : COMPUTER_USE_PERMISSION_COPY["screen-recording"].title,
    };
  return { kind: "not-allowed", missing: null };
}

/** The row as drawn, so a fixture can draw every state. */
export function MacAppsRowView({
  state,
  open,
  onOpenChange,
  onRetry,
  checklist,
}: AccessRowOpen & {
  readonly state: MacAppsRowState;
  readonly onRetry: () => void;
  /** The checklist, drawn while the row is open. */
  readonly checklist: ReactNode;
}) {
  const tx = useTx();
  const line =
    state.kind === "allowed"
      ? tx("Screen Recording and Accessibility are allowed.")
      : state.kind === "partly"
        ? tx("Partly allowed: {missing} is still off.", { missing: state.missing ?? "" })
        : state.kind === "needs-reopening"
          ? tx("Needs reopening: macOS applies Screen Recording after SpecWithCode reopens.")
          : state.kind === "could-not-check"
            ? tx("Could not check the Mac's permissions.")
            : tx("Agents see the screen and click and type in any app.");
  const actions =
    state.kind === "allowed" ? (
      <AccessRowChip on>{tx("Allowed")}</AccessRowChip>
    ) : state.kind === "could-not-check" ? (
      <AccessRowAction onClick={onRetry}>{tx("Retry")}</AccessRowAction>
    ) : (
      <AccessRowAction
        expands={{ row: "mac-apps", open }}
        onClick={() => onOpenChange(!open)}
        data-access-focus="mac-apps-toggle"
      >
        {open ? tx("Hide") : state.kind === "needs-reopening" ? tx("Reopen") : tx("Allow")}
      </AccessRowAction>
    );
  return (
    <AccessRow
      id="mac-apps"
      glyph={<MacAppsRowGlyph />}
      title={tx("Mac apps")}
      done={state.kind === "allowed"}
      state={<span data-mac-apps-state={state.kind}>{line}</span>}
      actions={actions}
      open={open && state.kind !== "allowed" && state.kind !== "could-not-check"}
    >
      {checklist}
    </AccessRow>
  );
}

/**
 * First-run's Mac apps row: Screen Recording and Accessibility for this Mac's
 * desktop app, read from the poll every card shares. Allow opens the same
 * checklist Settings shows, with its drag helper, Quit & Reopen and "Reset and
 * ask again".
 */
export function MacAppsRow({
  open,
  onOpenChange,
  onBeforeRelaunch,
}: AccessRowOpen & {
  /** Notes where setup is before Quit & Reopen. */
  readonly onBeforeRelaunch?: (() => Promise<unknown>) | undefined;
}) {
  const permissions = useComputerUsePermissions();
  const state = macAppsRowState({
    status: permissions.status,
    error: permissions.error,
    screenRecordingRequested: permissions.requested.has("screen-recording"),
  });
  return (
    <MacAppsRowView
      state={state}
      open={open}
      onOpenChange={onOpenChange}
      onRetry={permissions.retry}
      checklist={
        <ComputerUsePermissionChecklist state={permissions} onBeforeRelaunch={onBeforeRelaunch} />
      }
    />
  );
}
