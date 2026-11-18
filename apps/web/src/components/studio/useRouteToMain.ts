import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { isTransientSendFailure } from "../../lib/transientSendRetry";
import { useTx } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { coordinatorBoxState, type CoordinatorBoxState } from "../../studio/coordinatorBoxState";
import type { MainOffer } from "../../studio/makeMain";
import type { ProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { projectWorkspace } from "../../studio/projectWorkspace";
import {
  canRouteToMain,
  routeTarget,
  routedCommand,
  ROUTED_FILES_MESSAGE,
  type HeldRoute,
} from "../../studio/routeToMain";
import type { MainSwitchAfter } from "./useMakeMain";

/**
 * A machine without the coordinator sends what is typed in its message box to the
 * coordinator on its machine (`projects.coordinatorSend` there, with this window's operate
 * grant), then shows that machine's page, where the answer comes. Files stay on the machine
 * they were attached on, so a draft holding files is refused with the reason, never sent
 * without them. Nothing starts on the machine shown.
 */
export function useRouteToMain(input: {
  /** The coordinator's checkout, `environmentId:projectId`; null when it is on the machine shown. */
  readonly mainKey: string | null;
  /** The box cannot send here because the coordinator is elsewhere. */
  readonly copyOff: boolean;
  /** A live coordinator the resolver found, not a bare successor reference. */
  readonly mainLive: boolean;
  /** Shows the coordinator's page after the send; null until saved choices load. */
  readonly onOpen: ((key: string) => void) | null;
  /** Names for the refusal of a draft with files. */
  readonly project?: string;
  readonly machine?: string | null;
}): {
  readonly ready: boolean;
  /** The coordinator's machine, where a routed message runs; null when it is the machine shown. */
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly mayOperate: boolean;
  readonly sending: boolean;
  readonly send: (text: string, files?: readonly unknown[]) => Promise<void>;
} {
  const tx = useTx();
  const target = routeTarget(input.mainKey);
  const environmentId = (target?.environmentId ?? null) as EnvironmentId | null;
  const environment = useEnvironment(environmentId);
  const mayOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const sendCommand = useAtomCommand(projectWorkspace.send, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const held = useRef<HeldRoute | null>(null);
  const connected = environment?.connection.phase === "connected";
  const ready = canRouteToMain({
    copyOff: input.copyOff,
    target,
    mainLive: input.mainLive,
    mainConnected: connected,
    mayOperate,
  });
  const { mainKey, onOpen } = input;
  const send = async (text: string, files?: readonly unknown[]) => {
    if (!ready || !target || !mainKey)
      throw new Error(tx("The coordinator's machine is not reachable from here."));
    // Refused before anything is sent: the draft keeps its text and files.
    if (files?.length)
      throw new Error(
        tx(ROUTED_FILES_MESSAGE, {
          project: input.project ?? tx("this project"),
          machine: input.machine ?? tx("its machine"),
        }),
      );
    const command = routedCommand(held.current, mainKey, text, randomUUID);
    held.current = command;
    setSending(true);
    const result = await sendCommand({
      environmentId: target.environmentId as EnvironmentId,
      input: {
        projectId: target.projectId as ProjectId,
        commandId: CommandId.make(command.commandId),
        prompt: text,
      },
    }).finally(() => setSending(false));
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      // Only an answer from that machine is a refusal. A lost connection may have carried
      // the message, so it never reads "Nothing was sent."
      if (cause instanceof Error && cause.message && !isTransientSendFailure(cause))
        throw new RoutedSendRefused(cause.message);
      throw cause instanceof Error && cause.message
        ? cause
        : new Error(
            tx("The coordinator's machine did not confirm the message. It may not have arrived."),
          );
    }
    held.current = null;
    onOpen?.(mainKey);
  };
  return { ready, environmentId, connected, mayOperate, sending, send };
}

/** The coordinator's machine was asked and did not take the message: the text stays in the box. */
class RoutedSendRefused extends Error {}

/** How long a continued coordinator may take to show on this page before the send is given up. */
const CONTINUE_SEND_WAIT_MS = 20_000;

/**
 * The message box of a machine without the coordinator, wired: its state
 * (`coordinatorBoxState`), where Send goes, and "Continue here and send", which runs the
 * existing takeover and sends the typed text to the coordinator once it runs on this
 * machine. Nothing is held for later: when the takeover is put away, refused or does not
 * show here in time, the text stays in the box and the reason is said.
 */
export function useCoordinatorBox(input: {
  readonly mainKey: string | null;
  /** The coordinator's machine by name; null when this window does not know it. */
  readonly machine: string | null;
  readonly project: string;
  readonly copyOff: boolean;
  readonly mainLive: boolean;
  readonly onOpen: ((key: string) => void) | null;
  readonly composer: ProjectCoordinatorComposer;
  /** "Continue here" for the machine shown; null when it has none. */
  readonly offer: MainOffer | null;
  /** Runs that switch (`useMakeMain`); null where the page offers none. */
  readonly onContinue: ((key: string, after?: MainSwitchAfter) => void) | null;
  /** Sends to the coordinator on the machine shown, as the page does once it runs here. */
  readonly sendHere: (text: string) => Promise<unknown>;
}): {
  /** Send delivers to the coordinator on its machine. */
  readonly routes: boolean;
  readonly environmentId: EnvironmentId | null;
  /** The box's state; null when the coordinator is on the machine shown. */
  readonly state: CoordinatorBoxState | null;
  readonly sending: boolean;
  readonly send: (text: string, files?: readonly unknown[]) => Promise<void>;
  /** Runs "Continue here" on its own; null when there is none to run. */
  readonly continueHere: (() => void) | null;
  /** The box's button when it continues the coordinator here; null while it only sends. */
  readonly primary: { readonly text: string; readonly run?: () => void } | null;
} {
  const tx = useTx();
  const { composer, offer, onContinue, mainKey } = input;
  const route = useRouteToMain(input);
  const hasFiles = useSyncExternalStore(
    composer.subscribe,
    () => composer.getSnapshot().attachments.length > 0,
    () => false,
  );
  const hasText = useSyncExternalStore(
    composer.subscribe,
    () => composer.getSnapshot().prompt.trim().length > 0,
    () => false,
  );
  // The coordinator moved to another machine while a message was being typed: the line says
  // so until that draft is sent or cleared.
  const [seenKey, setSeenKey] = useState(mainKey);
  const [moved, setMoved] = useState(false);
  if (seenKey !== mainKey) {
    setSeenKey(mainKey);
    setMoved(seenKey !== null && mainKey !== null && hasText);
  } else if (moved && !hasText) setMoved(false);

  // What the coordinator's machine said when it refused the last send, until the next one
  // or until the coordinator is somewhere else.
  const [refusal, setRefusal] = useState<{
    readonly key: string | null;
    readonly reason: string;
  } | null>(null);
  const refused = refusal && refusal.key === mainKey ? refusal.reason : null;

  const state = input.copyOff
    ? coordinatorBoxState({
        project: input.project,
        machine: input.machine,
        routes: route.ready,
        machineConnected: route.connected,
        mayOperate: route.mayOperate,
        hasFiles,
        movedTo: moved ? input.machine : null,
        refused,
        offer: onContinue ? offer : null,
      })
    : null;

  // A text waiting for the coordinator to run here after "Continue here and send".
  const waiting = useRef<{
    readonly text: string;
    readonly done: () => void;
    readonly failed: (cause: unknown) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const [continued, setContinued] = useState(0);
  const latest = useRef(input.sendHere);
  latest.current = input.sendHere;
  const here = !input.copyOff;
  useEffect(() => {
    const held = waiting.current;
    // Only once this page shows the coordinator running here is a local send valid.
    if (!held || continued === 0 || !here) return;
    waiting.current = null;
    clearTimeout(held.timer);
    void latest.current(held.text).then(held.done, held.failed);
  }, [continued, here]);
  // A page that goes away while a send waits ends it: the composer outlives the page and
  // would stay busy for good.
  const nothingSent = tx("Nothing was sent.");
  const gone = useRef(nothingSent);
  gone.current = nothingSent;
  useEffect(
    () => () => {
      const held = waiting.current;
      waiting.current = null;
      if (!held) return;
      clearTimeout(held.timer);
      held.failed(new Error(gone.current));
    },
    [],
  );

  const continueAndSend = (text: string, files?: readonly unknown[]) =>
    new Promise<void>((done, failed) => {
      if (!offer || !onContinue) {
        failed(new Error(tx("Nothing was sent.")));
        return;
      }
      onContinue(offer.key, {
        stopped: () => failed(new Error(tx("Nothing was sent."))),
        continued: () => {
          // Files cannot follow in the same step: the coordinator continues, the draft stays.
          if (files?.length) {
            failed(new Error(tx("The coordinator continues here. Send your message again.")));
            return;
          }
          const timer = setTimeout(() => {
            if (waiting.current?.timer !== timer) return;
            waiting.current = null;
            failed(new Error(tx("The coordinator continues here. Send your message again.")));
          }, CONTINUE_SEND_WAIT_MS);
          waiting.current = { text, done, failed, timer };
          setContinued((count) => count + 1);
        },
      });
    });

  const send = async (text: string, files?: readonly unknown[]) => {
    setRefusal(null);
    if (state?.send.continues) await continueAndSend(text, files);
    else
      await route.send(text, files).catch((cause: unknown) => {
        if (cause instanceof RoutedSendRefused) setRefusal({ key: mainKey, reason: cause.message });
        throw cause;
      });
    setMoved(false);
  };
  const continueHere = offer && onContinue ? () => onContinue(offer.key) : null;
  return {
    routes: route.ready,
    environmentId: route.environmentId,
    state,
    sending: route.sending,
    send,
    continueHere,
    primary: state?.send.continues
      ? {
          text: tx(state.send.text),
          // A draft with files cannot be sent in the same step: the button only continues.
          ...(hasFiles && continueHere ? { run: continueHere } : {}),
        }
      : null,
  };
}
