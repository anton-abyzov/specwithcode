import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useRelayEnvironmentDiscovery } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { setFleetEnvironmentSkipped } from "../studio/fleetAutoConnect";
import { noteMachineRemoved } from "../studio/knownMachines";
import {
  accountNoteBeforeLoad,
  connectMachineOwnersChanged,
  planConnectMachineOwners,
  readConnectMachineOwners,
  writeConnectMachineOwners,
} from "./connectMachineOwners";

/** Failures that mean the machine is already gone from, or never was in, this window's list. */
const ALREADY_GONE = new Set(["EnvironmentNotRegisteredError", "PlatformEnvironmentRemovalError"]);

/** How long a forgotten machine that is saved again counts as the same late answer. */
const LATE_SAVE_WINDOW_MS = 2 * 60_000;

/**
 * Applies {@link planConnectMachineOwners} whenever the account or the saved
 * machines change (1434, D-01). Owners are recorded on every change, apart
 * from the removals. Machines saved under the account that left are forgotten
 * on this window only: automatic pairing skips them, then their saved routes,
 * credentials and cached projects and chats go. Nothing on the machines
 * themselves changes, and no project folder is touched.
 *
 * `account` is undefined until Connect has settled; nothing is planned before
 * that, nor removed before the saved list has loaded.
 */
export function ConnectMachineOwnersSync({
  account,
}: {
  readonly account: string | null | undefined;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const discovery = useRelayEnvironmentDiscovery();
  const forget = useAtomCommand(environmentCatalog.forget, {
    label: "Remove the previous account's machines",
    reportFailure: false,
  });
  // Read when a queued removal starts: it runs only for the account that asked.
  const accountRef = useRef(account);
  useLayoutEffect(() => {
    accountRef.current = account;
  }, [account]);
  const inFlight = useRef<Set<string>>(new Set());
  // Removals that failed for `failed.account` in this session; retried after a restart.
  const failed = useRef<{ account: string | null | undefined; ids: Set<string> }>({
    account: undefined,
    ids: new Set(),
  });
  const forgottenAt = useRef<Map<string, number>>(new Map());
  // Reported as not in this window's list (or owned by the host): left out of
  // planning for the session, so a list that still shows one never loops.
  const gone = useRef<Set<string>>(new Set());
  const [pass, setPass] = useState(0);

  const savedMachines = useMemo(
    () =>
      [...catalog.entries]
        // The window's own machine and its desktop-local backends (WSL) are never an account's.
        .filter(
          ([, entry]) =>
            entry.target._tag !== "PrimaryConnectionTarget" &&
            !isDesktopLocalConnectionTarget(entry.target),
        )
        .map(([environmentId]) => environmentId as string)
        .sort(),
    [catalog.entries],
  );
  const accountMachines = useMemo(
    () => new Set(discovery.environments.keys()),
    [discovery.environments],
  );

  useEffect(() => {
    if (account === undefined) return;
    const stored = readConnectMachineOwners();
    if (!catalog.isReady) {
      // Note who is signed in now, so a switch before the first load still counts.
      const note = accountNoteBeforeLoad(stored, account);
      if (note !== null) writeConnectMachineOwners(note);
      return;
    }
    if (failed.current.account !== account) failed.current = { account, ids: new Set() };
    const now = Date.now();
    const forceDrop = new Set<string>();
    for (const [id, at] of forgottenAt.current) {
      if (now - at > LATE_SAVE_WINDOW_MS) forgottenAt.current.delete(id);
      else if (savedMachines.includes(id) && !inFlight.current.has(id)) {
        forceDrop.add(id);
        gone.current.delete(id);
      }
    }
    const listed = savedMachines.filter((id) => !gone.current.has(id));
    const plan = planConnectMachineOwners({
      stored,
      account,
      savedMachines: listed,
      accountMachines,
      pending: new Set([...failed.current.ids, ...inFlight.current]),
      forceDrop,
    });
    if (connectMachineOwnersChanged(stored, plan.next)) writeConnectMachineOwners(plan.next);

    for (const id of plan.drop) {
      if (inFlight.current.has(id)) continue;
      inFlight.current.add(id);
      const environmentId = id as EnvironmentId;
      // Recorded first, so automatic pairing cannot add it back in between.
      setFleetEnvironmentSkipped(environmentId, true);
      void (async () => {
        const result = await forget({
          environmentId,
          proceed: () => accountRef.current === account,
        });
        inFlight.current.delete(id);
        if (result._tag === "Success") {
          if (result.value) {
            forgottenAt.current.set(id, Date.now());
            noteMachineRemoved(environmentId, true);
          } else {
            // The account changed before it ran: the next plan decides again.
            setFleetEnvironmentSkipped(environmentId, false);
          }
        } else {
          const failure = isAtomCommandInterrupted(result)
            ? null
            : (squashAtomCommandFailure(result) as { readonly _tag?: unknown } | null);
          const tag = typeof failure?._tag === "string" ? failure._tag : null;
          if (tag !== null && ALREADY_GONE.has(tag)) {
            gone.current.add(id);
            if (tag === "EnvironmentNotRegisteredError") noteMachineRemoved(environmentId, true);
          } else {
            console.warn("Could not remove a machine saved under the previous Connect account.", {
              environmentId,
            });
            if (failed.current.account === account) failed.current.ids.add(id);
          }
        }
        // Plan again: owners are rewritten, and the previous account stays
        // recorded while a removal is still owed.
        setPass((value) => value + 1);
      })();
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `pass` plans again after a removal
  }, [account, accountMachines, catalog.isReady, forget, pass, savedMachines]);

  return null;
}
