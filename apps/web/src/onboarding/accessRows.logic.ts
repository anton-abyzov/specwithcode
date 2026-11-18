/**
 * Which rows first-run's Access step shows, and the machines each acts on.
 *
 * One pure function, so the stage rule (Access is in the bar only when it has a
 * row) and the step's own list can never disagree. Rows that act on "this
 * computer" show only in the desktop app: a browser tab cannot tell whether the
 * server behind it is the same computer (a tunnel or a forwarded port looks like
 * `localhost`), so a tab gets only Files and commands.
 */

export type AccessRowId = "files" | "browser" | "mac-apps" | "iphone" | "full-disk-access";

/** What 1395 reads through the desktop bridge; anything but `present` hides the iPhone row. */
export type IphoneMirroringFact = "present" | "absent" | "unknown";

export interface AccessRowsMachine<Id extends string = string> {
  readonly id: Id;
  /** The machine this window's app runs on. */
  readonly own: boolean;
  /** `darwin`, `win32`, `linux`; null while it is not known. */
  readonly platform: string | null;
  /**
   * Full access was recommended for it when the step opened, or an answer was
   * given on this run. Once true it stays true for the run.
   */
  readonly recommended: boolean;
  /** The Mac permissions shown here are this machine's (`useComputerUsePermissionsAreLocal`). */
  readonly computerUseLocal?: boolean;
  /** 1386's rule for its first-run item: this window can open System Settings on this Mac. */
  readonly fullDiskAccessLocal?: boolean;
  /** Supplied by 1395. Missing counts as `unknown`. */
  readonly iphoneMirroring?: IphoneMirroringFact;
}

export interface AccessRowsInput<Id extends string = string> {
  /** The machines being set up. */
  readonly machines: readonly AccessRowsMachine<Id>[];
  /** The window is the desktop app (`window.desktopBridge` exists). */
  readonly desktopApp: boolean;
}

export interface AccessRowPlan<Id extends string = string> {
  readonly id: AccessRowId;
  /** The machines the row acts on. */
  readonly machineIds: readonly Id[];
}

/** The rows in the order the step lists them; empty means the stage is not shown. */
export function accessRows<Id extends string>(
  input: AccessRowsInput<Id>,
): readonly AccessRowPlan<Id>[] {
  const rows: AccessRowPlan<Id>[] = [];
  const recommended = input.machines.filter((machine) => machine.recommended);
  if (recommended.length > 0) {
    rows.push({ id: "files", machineIds: recommended.map((machine) => machine.id) });
  }
  const own = input.desktopApp ? input.machines.find((machine) => machine.own) : undefined;
  if (own === undefined) return rows;
  const here = [own.id];
  rows.push({ id: "browser", machineIds: here });
  const mac = own.platform === "darwin";
  if (mac && own.computerUseLocal === true) {
    rows.push({ id: "mac-apps", machineIds: here });
    if (own.iphoneMirroring === "present") rows.push({ id: "iphone", machineIds: here });
  }
  if (mac && own.fullDiskAccessLocal === true) {
    rows.push({ id: "full-disk-access", machineIds: here });
  }
  return rows;
}
