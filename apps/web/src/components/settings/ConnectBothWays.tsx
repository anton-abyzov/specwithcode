/**
 * "Its app sees this machine": app connections live in each app, so the other
 * machine's app opens a one-time link made here. Shown in a machine card's
 * Connection details.
 *
 * @module ConnectBothWays
 */
import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  type AdvertisedEndpoint,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { useTx } from "../../i18n";
import { renderRich } from "../../i18n/rich";
import { isElectron } from "../../env";
import {
  createServerPairingCredential,
  readPrimaryEnvironmentTarget,
} from "../../environments/primary";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useServerConfigs } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useStudioFleet } from "../../studio/fleet";
import { useMachineNickname } from "../../studio/machineNickname";
import type { TeamRulesLock } from "../../teamRules/teamRulesView";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  connectBothWaysInstruction,
  pairingLinkBaseUrl,
  type MachineRowModel,
} from "./machinesSettings.logic";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { DetailLine } from "./DetailLine";
import { TeamRulesLockNote } from "./TeamRulesLock";

const NO_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

// The desktop bridge is fixed for the window's lifetime, so the hook choice is too.
const useDesktopAdvertisedEndpoints = isElectron
  ? () => {
      const result = useAtomValue(desktopNetworkAccessStateAtom);
      return Option.getOrNull(AsyncResult.value(result))?.advertisedEndpoints ?? NO_ENDPOINTS;
    }
  : () => NO_ENDPOINTS;

/** The server this window talks to, which is not always the page's own origin. */
function currentServerOrigin(): string | null {
  try {
    return readPrimaryEnvironmentTarget()?.target.httpBaseUrl ?? window.location.origin;
  } catch {
    return null;
  }
}

export interface CreatedLink {
  /** Null when no address another machine can open is known; the code still works. */
  readonly link: string | null;
  readonly code: string;
  readonly expiresAt: string;
}

/**
 * The step this app cannot do for the other machine: app connections live in
 * each app, so the other machine's app must open a link made here. The link
 * stays in this component's state and is never logged.
 */
export function ConnectBothWays({
  row,
  primaryEnvironmentId,
}: {
  row: MachineRowModel;
  primaryEnvironmentId: EnvironmentId;
}) {
  // The address the other machine's server already uses for this one, if it lists it.
  const there = useStudioFleet(row.environmentId);
  const configs = useServerConfigs();
  const advertised = useDesktopAdvertisedEndpoints();
  const canCreate = useEnvironmentScope(primaryEnvironmentId, AuthAccessWriteScope);
  const nickname = useMachineNickname(row.environmentId, row.label);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedLink | null>(null);

  async function create() {
    if (creating || !canCreate || row.connectLock !== null) return;
    const scopes = AuthStandardClientScopes.filter((scope) =>
      readEnvironmentScope(primaryEnvironmentId, scope),
    );
    if (scopes.length === 0) return;
    setCreating(true);
    try {
      const result = await createServerPairingCredential({
        label: `App on ${nickname}`,
        coordinatorEnvironmentId: row.environmentId,
        scopes,
      });
      const host = pairingLinkBaseUrl({
        addressSeenThere:
          there.snapshot?.machines.find((machine) => machine.environmentId === primaryEnvironmentId)
            ?.url ?? null,
        pageUrl: currentServerOrigin(),
        directEndpoints: configs.get(primaryEnvironmentId)?.directEndpoints ?? [],
        advertisedEndpoints: advertised,
      });
      setCreated({
        link: host ? resolveDesktopPairingUrl(host, result.credential) : null,
        code: result.credential,
        expiresAt: new Date(DateTime.toEpochMillis(result.expiresAt)).toLocaleTimeString(
          undefined,
          { hour: "numeric", minute: "2-digit" },
        ),
      });
    } catch (failure) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not create a pairing link",
          description: failure instanceof Error ? failure.message : "Try again in a moment.",
        }),
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <ConnectBothWaysView
      machineLabel={nickname}
      canCreate={canCreate}
      creating={creating}
      created={created}
      teamRulesLock={row.connectLock}
      onCreate={() => void create()}
      onDone={() => setCreated(null)}
    />
  );
}

async function copyText(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toastManager.add(stackedThreadToast({ type: "success", title: `${what} copied` }));
  } catch {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not copy the ${what.toLowerCase()}`,
        description: "Select it and copy it by hand.",
      }),
    );
  }
}

export function ConnectBothWaysView({
  machineLabel,
  canCreate,
  creating,
  created,
  teamRulesLock = null,
  onCreate,
  onDone,
}: {
  machineLabel: string;
  canCreate: boolean;
  creating: boolean;
  created: CreatedLink | null;
  teamRulesLock?: TeamRulesLock | null;
  onCreate: () => void;
  onDone: () => void;
}) {
  const tx = useTx();
  return (
    <DetailLine
      label={tx("Its app sees this machine")}
      help="Whether the SpecWithCode app on that machine can open this machine's projects. It is about you, the person, not agents, so it does not change who may start work where."
    >
      {teamRulesLock !== null ? (
        <TeamRulesLockNote lock={teamRulesLock} />
      ) : created === null ? (
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {tx(
              "No. To open this machine's projects from {machineLabel}, make a one-time link here and open it there.",
              { machineLabel },
            )}
          </p>
          <Button
            className="shrink-0 self-start sm:self-auto"
            size="xs"
            variant="outline"
            disabled={creating || !canCreate}
            onClick={onCreate}
          >
            {creating
              ? tx("Creating…")
              : canCreate
                ? tx("Make pairing link")
                : tx("Manage access required")}
          </Button>
        </div>
      ) : (
        <div className="min-w-0 space-y-1.5">
          <p className="text-xs text-foreground/80">
            {created.link
              ? connectBothWaysInstruction(machineLabel)
              : `On ${machineLabel}, open Settings > Machines > Advanced > Saved connections > Add connection > Remote link, enter this machine's private address and this pairing code.`}
          </p>
          <div className="flex min-w-0 gap-2">
            <Input
              readOnly
              size="sm"
              className="min-w-0 flex-1 font-mono text-xs"
              aria-label={created.link ? tx("Pairing link") : tx("Pairing code")}
              value={created.link ?? created.code}
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void copyText(created.link ?? created.code, created.link ? "Link" : "Pairing code")
              }
            >
              {tx("Copy")}
            </Button>
            <Button size="xs" variant="ghost-muted" onClick={onDone}>
              {tx("Done")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {renderRich(
              tx(
                "Works once, until {expiresAt}. Paste it only into SpecWithCode on {machineLabel}, not into a chat.",
              ),
              { expiresAt: created.expiresAt, machineLabel: machineLabel },
            )}
          </p>
        </div>
      )}
    </DetailLine>
  );
}
