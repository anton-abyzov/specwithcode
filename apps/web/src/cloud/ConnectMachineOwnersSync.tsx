import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { useRelayEnvironmentDiscovery } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import { setFleetEnvironmentSkipped } from "../studio/fleetAutoConnect";
import { noteMachineRemoved } from "../studio/knownMachines";
import {
  connectMachineOwnersChanged,
  planConnectMachineOwners,
  readConnectMachineOwners,
  writeConnectMachineOwners,
} from "./connectMachineOwners";

/** Failures that mean the machine is already gone from, or never was in, this window's list. */
const ALREADY_GONE = new Set(["EnvironmentNotRegisteredError", "PlatformEnvironmentRemovalError"]);

/**
 * Applies {@link planConnectMachineOwners} whenever the account or the saved
 * machines change (1363, D-01). Machines saved under the account that left are
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
  const remove = useAtomCommand(environmentCatalog.remove, {
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
        .filter(([, entry]) => entry.target._tag !== "PrimaryConnectionTarget")
        .map(([environmentId]) => environmentId as string)
        .sort(),
    [catalog.entries],
  );
  const accountMachines = useMemo(
    () => new Set(discovery.environments.keys()),
    [discovery.environments],
  );

  useEffect(() => {
    if (account === undefined || !catalog.isReady || running.current) return;
    for (const id of dropped.current) if (!savedMachines.includes(id)) dropped.current.delete(id);
    const listed = savedMachines.filter((id) => !dropped.current.has(id));
    const stored = readConnectMachineOwners();
    const plan = planConnectMachineOwners({
      stored,
      account,
      savedMachines: listed,
      accountMachines,
    });
    if (plan.drop.length === 0) {
      if (connectMachineOwnersChanged(stored, plan.next)) writeConnectMachineOwners(plan.next);
      return;
    }
    running.current = true;
    void (async () => {
      let complete = true;
      for (const id of plan.drop) {
        const environmentId = id as EnvironmentId;
        // Recorded first, so automatic pairing cannot add it back in between.
        setFleetEnvironmentSkipped(environmentId, true);
        const result = await remove(environmentId);
        if (result._tag !== "Failure") {
          dropped.current.add(id);
          noteMachineRemoved(environmentId, true);
          continue;
        }
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result) as { readonly _tag?: unknown } | null;
          if (typeof failure?._tag === "string" && ALREADY_GONE.has(failure._tag)) {
            dropped.current.add(id);
            continue;
          }
        }
        console.warn("Could not remove a machine saved under the previous Connect account.", {
          environmentId,
        });
        complete = false;
      }
      // The previous account is kept as the last one until every machine is gone,
      // so a restart or the next change finishes the cleanup.
      running.current = false;
      if (!complete) return; // retried on the next change, not in a loop
      writeConnectMachineOwners(plan.next);
      setPass((value) => value + 1);
    })();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `pass` plans again after a run
  }, [account, accountMachines, catalog.isReady, pass, remove, savedMachines]);

  return null;
}
