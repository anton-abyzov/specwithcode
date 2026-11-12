import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@specweave-studio/contracts";
import {
  turnItemDetailRevision,
  turnItemNeedsDetailFetch,
} from "@specweave-studio/client-runtime/work-log/item-detail";
import { ArrowUpRight, Smartphone } from "lucide-react";
import { createContext, type ReactNode, use, useMemo, useState } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { deviceEnvironment, useDeviceState } from "~/state/device";
import { useThreadVisibleTurnItems } from "~/state/entities";
import { formatEnvironmentQueryError } from "~/state/query";
import { useTurnItemDetail } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  RUN_ON_DEVICE_CARD_LIMIT,
  type RunOnDeviceCardDevice,
  type RunOnDeviceCardModel,
  runOnDeviceCard,
  runOnDeviceKey,
  runOnDeviceRowId,
  runOnDeviceSource,
} from "./runOnDeviceCard.logic";

const RunOnDeviceCardCtx = createContext<{
  readonly rowId: string;
  readonly threadRef: ScopedThreadRef;
  readonly model: RunOnDeviceCardModel;
} | null>(null);

/** A device tool's full result; the timeline withholds it, so it is read once per call. */
function useDeviceToolOutput(
  environmentId: EnvironmentId | null,
  row: OrchestrationV2ProjectedTurnItem | null,
): unknown {
  const item = row?.item;
  const fetches = item?.type === "dynamic_tool" && turnItemNeedsDetailFetch(item);
  const detail = useTurnItemDetail(
    row !== null && item !== undefined && environmentId !== null && fetches
      ? {
          environmentId,
          threadId: row.sourceThreadId,
          itemId: row.sourceItemId,
          revision: turnItemDetailRevision(item),
        }
      : null,
  );
  if (item?.type !== "dynamic_tool") return undefined;
  if (!fetches) return item.output;
  const fetched = detail.data?.item;
  return fetched?.type === "dynamic_tool" ? fetched.output : undefined;
}

/** Finds the thread's one Run on device card and the timeline row it follows. */
export function RunOnDeviceCardProvider(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly rows: ReadonlyArray<{ readonly id: string; readonly createdAt: string | null }>;
  readonly children: ReactNode;
}) {
  const { threadRef, rows } = props;
  const items = useThreadVisibleTurnItems(threadRef);
  const source = useMemo(() => runOnDeviceSource(items), [items]);
  const environmentId = threadRef?.environmentId ?? null;
  const list = useDeviceToolOutput(environmentId, source?.list ?? null);
  const open = useDeviceToolOutput(environmentId, source?.list ? null : (source?.open ?? null));
  const model = useMemo(() => runOnDeviceCard({ list, open }), [list, open]);
  const anchorId = source?.anchor.itemId;
  const anchorAt = source?.anchor.createdAt;
  const rowId = useMemo(
    () =>
      anchorId === undefined || anchorAt === undefined
        ? null
        : runOnDeviceRowId(rows, { itemId: anchorId, createdAt: anchorAt }),
    [rows, anchorId, anchorAt],
  );
  const value = useMemo(
    () => (threadRef && model && rowId ? { rowId, threadRef, model } : null),
    [threadRef, model, rowId],
  );
  return <RunOnDeviceCardCtx value={value}>{props.children}</RunOnDeviceCardCtx>;
}

/** Renders the card under the one timeline row it belongs to. */
export function RunOnDeviceCardSlot({ rowId }: { readonly rowId: string }) {
  const card = use(RunOnDeviceCardCtx);
  if (card === null || card.rowId !== rowId) return null;
  return <RunOnDeviceCard threadRef={card.threadRef} model={card.model} />;
}

const deviceKind = ({ device }: RunOnDeviceCardDevice) =>
  device.physical ? "Phone" : device.platform === "ios" ? "Simulator" : "Emulator";

/**
 * Devices the agent listed in this thread. Choosing one opens it the way the
 * Device panel's picker does; install and launch stay with the agent.
 */
export function RunOnDeviceCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly model: RunOnDeviceCardModel;
}) {
  const { threadRef, model } = props;
  const { environmentId, threadId } = threadRef;
  const { state, loaded } = useDeviceState(environmentId);
  const openCommand = useAtomCommand(deviceEnvironment.open);
  // A pick is tagged with its thread, so a late answer only shows where it started.
  const scope = `${environmentId}\u0000${threadId}`;
  const [operation, setOperation] = useState<{
    readonly scope: string;
    readonly pending: string | null;
    readonly error: string | null;
  } | null>(null);
  const pendingKey = operation?.scope === scope ? operation.pending : null;
  const error = operation?.scope === scope ? operation.error : null;

  const openKeys = useMemo(
    () =>
      new Set(
        loaded
          ? state.sessions
              .filter((session) => session.threadId === threadId)
              .map((session) => runOnDeviceKey(session))
          : model.openKeys,
      ),
    [loaded, model.openKeys, state.sessions, threadId],
  );
  const shown = model.devices.slice(0, RUN_ON_DEVICE_CARD_LIMIT);
  const more = model.devices.length - shown.length;

  const showDevicePanel = () => useRightPanelStore.getState().open(threadRef, "device");

  const select = async (entry: RunOnDeviceCardDevice) => {
    if (pendingKey !== null) return;
    const { device } = entry;
    // Setup is not finished, or not known yet: the Device panel loads the state
    // and walks through setup when needed, as from the + menu.
    if (!loaded || !state.onboardingCompleted || state.hostStatus === "disabled") {
      showDevicePanel();
      return;
    }
    const key = runOnDeviceKey({ hostId: device.hostId, deviceId: device.id });
    const target = {
      hostId: device.hostId,
      deviceId: device.id,
      platform: device.platform,
      name: device.name,
    };
    if (openKeys.has(key)) {
      useRightPanelStore.getState().openDevice(threadRef, target);
      return;
    }
    const started = { scope, pending: key, error: null };
    setOperation(started);
    const settle = (message: string | null) =>
      setOperation((current) =>
        current === started ? { ...started, pending: null, error: message } : current,
      );
    const result = await openCommand({
      environmentId,
      input: { threadId, hostId: device.hostId, deviceId: device.id, platform: device.platform },
    });
    if (result._tag === "Failure") {
      settle(formatEnvironmentQueryError(result.cause) ?? `Could not open ${device.name}.`);
      return;
    }
    useRightPanelStore.getState().openDevice(threadRef, {
      ...target,
      hostId: result.value.hostId,
      deviceId: result.value.deviceId,
    });
    settle(null);
  };

  return (
    <section
      aria-label="Run on device"
      data-testid="run-on-device-card"
      className="my-1 rounded-lg border border-border/70 px-3 py-2"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <Smartphone aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        Run on device
      </p>
      {model.hint ? <p className="mt-1 text-xs text-muted-foreground">{model.hint}</p> : null}
      {shown.length > 0 ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {shown.map((entry) => {
            const { device } = entry;
            const key = runOnDeviceKey({ hostId: device.hostId, deviceId: device.id });
            const isOpen = openKeys.has(key);
            const pending = pendingKey === key;
            const action = pending ? "Opening" : isOpen ? "Open" : device.booted ? "Show" : "Start";
            return (
              <li key={key} className="flex items-center gap-3">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-foreground">{device.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[deviceKind(entry), device.version, entry.hostLabel]
                      .filter((part) => part)
                      .join(" · ")}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  aria-label={`${action} ${device.name}`}
                  aria-busy={pending}
                  disabled={pendingKey !== null}
                  data-state={isOpen ? "open" : undefined}
                  onClick={() => void select(entry)}
                >
                  {pending ? <Spinner size="xs" /> : <ArrowUpRight />}
                  {pending ? `${action}…` : action}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {more > 0 ? (
        <Button variant="link" size="xs" className="mt-1 px-0" onClick={showDevicePanel}>
          {`and ${more} more in the Device panel`}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-1 whitespace-pre-wrap text-xs text-destructive-foreground">
          {error}
        </p>
      ) : null}
    </section>
  );
}
