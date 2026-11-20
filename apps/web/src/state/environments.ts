import { useAtomValue } from "@effect/atom-react";
import {
  connectionCatalogDisplayUrl,
  hasRelayRoute,
  type EnvironmentPresentation as BaseEnvironmentPresentation,
} from "@specweave-studio/client-runtime/connection";
import { Discovery } from "@specweave-studio/client-runtime/relay";
import type { EnvironmentId } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { useMemo } from "react";

import {
  type ConnectAccountState,
  connectAccountStateAtom,
  connectSignInShown,
} from "../cloud/connectAccountState";
import { environmentCatalog } from "../connection/catalog";
import { txNow, useLocale } from "../i18n";
import { translateDeviceRefusal } from "../studio/connectDevices.logic";
import {
  environmentPresentations,
  environmentSummaries,
  useEnvironmentPresentation,
} from "./presentation";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { relayEnvironmentDiscovery } from "./relay";
import { usePreparedConnection } from "./session";

export interface EnvironmentPresentation extends BaseEnvironmentPresentation {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly displayUrl: string | null;
  readonly relayManaged: boolean;
}

const deviceRefusalText = (message: string) => translateDeviceRefusal(message, txNow);

/**
 * The connection with its sign-in mark dropped unless Clerk says signed out
 * (1417). Until then the refusal is a startup step, neither a sign-in to ask
 * for nor this machine refusing the window, so its "authentication" reason
 * goes with it and every word keyed on that reason waits too.
 */
export function gateConnectSignIn<
  T extends { readonly connectSignInRequired?: boolean; readonly blockedReason?: string },
>(connection: T, account: ConnectAccountState): T {
  if (connection.connectSignInRequired === undefined) return connection;
  if (connectSignInShown(connection.connectSignInRequired, account)) return connection;
  const { connectSignInRequired: _dropped, blockedReason, ...rest } = connection;
  return (
    blockedReason === undefined || blockedReason === "authentication"
      ? rest
      : { ...rest, blockedReason }
  ) as T;
}

export function projectEnvironmentPresentation(
  environmentId: EnvironmentId,
  presentation: BaseEnvironmentPresentation,
  account: ConnectAccountState,
): EnvironmentPresentation {
  const gated = gateConnectSignIn(presentation.connection, account);
  const error = gated.error;
  return {
    ...presentation,
    // The device gate's refusal, in this window's language (1327).
    connection: error ? { ...gated, error: deviceRefusalText(error) } : gated,
    environmentId,
    label: presentation.entry.target.label,
    displayUrl: connectionCatalogDisplayUrl(presentation.entry),
    relayManaged: hasRelayRoute(presentation.entry),
  };
}

export function useEnvironments() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const presentationById = useAtomValue(environmentPresentations.presentationsAtom);
  const account = useAtomValue(connectAccountStateAtom);
  // A refusal is said in the window's language, so a language change redraws it.
  const locale = useLocale();

  const environments = useMemo(
    () =>
      [...presentationById.entries()].map(([environmentId, presentation]) =>
        projectEnvironmentPresentation(environmentId, presentation, account),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- locale changes the projected text
    [presentationById, account, locale],
  );

  return {
    isReady: catalog.isReady,
    networkStatus,
    environments,
    presentationById,
  };
}

export function usePrimaryEnvironmentId(): EnvironmentId | null {
  return useAtomValue(primaryEnvironmentIdAtom);
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): EnvironmentPresentation | null {
  const { presentation } = useEnvironmentPresentation(environmentId);
  const account = useAtomValue(connectAccountStateAtom);
  return useMemo(
    () =>
      environmentId === null || presentation === null
        ? null
        : projectEnvironmentPresentation(environmentId, presentation, account),
    [environmentId, presentation, account],
  );
}

export function usePrimaryEnvironment(): EnvironmentPresentation | null {
  return useEnvironment(usePrimaryEnvironmentId());
}

export function useEnvironmentHttpBaseUrl(environmentId: EnvironmentId | null): string | null {
  const prepared = usePreparedConnection(environmentId);
  return Option.isSome(prepared) ? prepared.value.httpBaseUrl : null;
}

export function useRelayEnvironmentDiscovery(): Discovery.RelayEnvironmentDiscoveryState {
  return useAtomValue(relayEnvironmentDiscovery.stateValueAtom);
}

export function useEnvironmentIds() {
  return useAtomValue(environmentSummaries.environmentIdsAtom);
}

export function useEnvironmentIdentities() {
  return useAtomValue(environmentSummaries.identitiesAtom);
}

export function usePullRequestsSupported() {
  return useAtomValue(environmentSummaries.pullRequestsSupportedAtom);
}

export function useEnvironmentMachines() {
  return useAtomValue(environmentSummaries.machineByIdAtom);
}

export function useConnectedEnvironmentIds() {
  return useAtomValue(environmentSummaries.connectedEnvironmentIdsAtom);
}

export {
  environmentReachState,
  isEnvironmentUnreachable,
  unreachableEnvironmentIds,
  useMachineReachStates,
  useUnreachableEnvironmentIds,
  type MachineReachStates,
} from "./machineReach";
