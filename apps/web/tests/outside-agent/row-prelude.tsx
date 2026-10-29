// The fixture compiles the unmodified private SavedBackendListRow body from source.
// Transport/update state and unrelated controls are isolated; URL selection,
// clipboard handling, menu, row and tooltip components are production code.
import { useState, useCallback } from "react";
import { ChevronRightIcon, EllipsisIcon, PencilIcon, RouteIcon } from "lucide-react";
import * as Option from "effect/Option";
import { resolveEnvironmentMachineKind, type EnvironmentId } from "@specweave-studio/contracts";
import {
  connectionRoutes,
  connectionStatusText,
  environmentMcpUrl,
  environmentPublicMcpUrl,
} from "@specweave-studio/client-runtime/connection";
import type { EnvironmentPresentation } from "../../src/state/environments";
import { useCopyToClipboard } from "../../src/hooks/useCopyToClipboard";
import { cn } from "../../src/lib/utils";
import {
  EnvironmentRow,
  environmentTransportLabel,
} from "../../src/components/settings/EnvironmentRow";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../../src/components/ui/tooltip";
import { Switch } from "../../src/components/ui/switch";
import { Button } from "../../src/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from "../../src/components/ui/menu";
import {
  useAtomValue,
  serverEnvironment,
  usePreparedConnection,
  useRelayEnvironmentDiscovery,
} from "./mocks";
const useMachineNickname = (_id: unknown, label: string) => label;
const resolveServerConfigVersionMismatch = (
  _config: unknown,
): { serverVersion: string; clientVersion: string } | null => null;
const savedMachineStatus = (..._args: unknown[]) => ({
  text: "Ready",
  tone: "ready",
  reason: null,
  retryable: false,
});
const isThisMachineTarget = (_entry: unknown) => false;
const useMachineLastSeenVersion = () => undefined;
const machineLastSeenAt = (_id: unknown) => null;
const lastSeenLabel = (..._args: unknown[]) => null;
const toastManager = { add: (_value: unknown) => undefined };
const stackedThreadToast = (value: unknown) => value;
const ManagedConnectionUpdates = (_props: unknown) => null;
const EnvironmentRoutesList = (_props: unknown) => null;
const EnvironmentIconMenu = (_props: unknown) => null;
const RenameMachineDialog = (_props: unknown) => null;
const ConnectionReason = (_props: unknown) => null;
const OutdatedServerUpdateAction = (_props: unknown) => null;
const ServerUpdateAction = (_props: unknown) => null;
const resolveServerSelfUpdateCapability = (_config: unknown) => null;
const supportsDesktopAppUpdate = (_config: unknown) => false;
const supportsServerUpdateThreadContinuation = (_config: unknown) => false;
const APP_VERSION = "fixture";
