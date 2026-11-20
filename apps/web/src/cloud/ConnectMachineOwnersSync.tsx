import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";

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

/**
 * Applies {@link planConnectMachineOwners} whenever the account or the saved
 * machines change (1434, D-01). Machines saved under the account that left are
 * removed from this window like a person's Remove: automatic pairing skips
 * them, then their saved routes, credentials and cached projects and chats go.
 * Nothing on the machines themselves changes, and no project folder is touched.
 *
 * `account` is undefined until Connect has settled; nothing runs before that,
 * nor before the saved list has loaded, so an empty early list never reads as
 * "every machine was removed".
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
  const running = useRef(false);
  // Removed here but maybe still in the list this render saw: never planned
  // again (and so never tagged as the new account's) until the list drops them.
  const dropped = useRef<Set<string>>(new Set());
  // Bumped after a run, so changes that arrived while it ran are planned again.
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

  // Kept current on every render, so a run started for one account stops when it changes.
  const accountRef = useRef(account);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);
  // Removals that failed for `pending.account` in this session; retried after a restart.
  const pending = useRef<{ account: string | null | undefined; ids: Set<string> }>({
    account: undefined,
    ids: new Set(),
  });

  useEffect(() => {
    if (account === undefined || running.current) return;
    const stored = readConnectMachineOwners();
    if (!catalog.isReady) {
      // Note who is signed in now, so a switch before the first load still counts.
      const note = accountNoteBeforeLoad(stored, account);
      if (note !== null) writeConnectMachineOwners(note);
      return;
    }
    if (pending.current.account !== account) pending.current = { account, ids: new Set() };
    for (const id of dropped.current) if (!savedMachines.includes(id)) dropped.current.delete(id);
    const listed = savedMachines.filter((id) => !dropped.current.has(id));
    const plan = planConnectMachineOwners({
      stored,
      account,
      savedMachines: listed,
      accountMachines,
      pending: pending.current.ids,
    });
    if (plan.drop.length === 0) {
      if (connectMachineOwnersChanged(stored, plan.next)) writeConnectMachineOwners(plan.next);
      return;
    }
    running.current = true;
    void (async () => {
      for (const id of plan.drop) {
        // The account changed again: this plan no longer applies.
        if (accountRef.current !== account) break;
        const environmentId = id as EnvironmentId;
        // Recorded first, so automatic pairing cannot add it back in between.
        setFleetEnvironmentSkipped(environmentId, true);
        // Forget it on this window only: nothing running on that machine is stopped.
        const result = await forget(environmentId);
        if (result._tag !== "Failure") {
          dropped.current.add(id);
          noteMachineRemoved(environmentId, true);
          continue;
        }
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result) as { readonly _tag?: unknown } | null;
          if (typeof failure?._tag === "string" && ALREADY_GONE.has(failure._tag)) {
            dropped.current.add(id);
            if (failure._tag === "EnvironmentNotRegisteredError") {
              noteMachineRemoved(environmentId, true);
            }
            continue;
          }
        }
        console.warn("Could not remove a machine saved under the previous Connect account.", {
          environmentId,
        });
        if (pending.current.account === account) pending.current.ids.add(id);
      }
      running.current = false;
      // Plan again from storage: owners of machines saved meanwhile are recorded,
      // and the previous account stays recorded while a removal is still owed.
      setPass((value) => value + 1);
    })();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `pass` plans again after a run
  }, [account, accountMachines, catalog.isReady, forget, pass, savedMachines]);

  return null;
}
