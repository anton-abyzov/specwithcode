/**
 * A sheet file edited live: this window joins the file's session on the
 * machine that holds it, and the sheet on screen is the merge of everyone's
 * edits. Null while the machine cannot hold a session (an older server, a
 * file that is not a sheet in the project), so the caller saves by revision
 * as before.
 */
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type DocumentSessionPlace,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { SHEET_ARTIFACT_SUFFIX } from "@specweave-studio/shared/officeSheet";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useServerConfigs } from "~/state/entities";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { useTx } from "../../i18n";
import { documentSession, receiveDocumentSession } from "./documentSessionRpc";
import type { SheetLiveBinding } from "../office/SheetView";
import { type LiveSheetSendResult, type LiveSheetState, LiveSheetStore } from "./liveSheetStore";
import { type PresenceEntry, presenceEntries } from "./presence";

export interface LiveSheet {
  readonly state: LiveSheetState;
  /** Everyone on the sheet, this window included. */
  readonly presence: ReadonlyArray<PresenceEntry>;
  /** What the sheet view edits through; null until the session has the sheet, and after it ends. */
  readonly binding: SheetLiveBinding | null;
}

/** The sheet view's side of a live store. */
export function liveSheetBinding(
  store: LiveSheetStore,
  state: LiveSheetState,
  presence: ReadonlyArray<PresenceEntry>,
): SheetLiveBinding | null {
  if (state.status !== "live" || state.document === null) return null;
  return {
    document: state.document,
    tabIds: state.tabIds,
    editable: state.access === "edit",
    commit: (next) => store.commit(next),
    undo: () => store.undo(),
    redo: () => store.redo(),
    canUndo: state.canUndo,
    canRedo: state.canRedo,
    problem: state.problem ?? state.unsaved,
    clearProblem: () => store.clearProblem(),
    setPlace: store.setPlace,
    others: presence.filter((entry) => !entry.self),
  };
}

function newSessionKey(): string {
  return randomUUID().replaceAll("-", "");
}

function sendResult(failure: unknown): LiveSheetSendResult {
  const code = (failure as { code?: unknown } | null)?.code;
  return code === "view_only" || code === "refused" || code === "not_open" ? code : "failed";
}

export function useLiveSheet(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  /** The sheet's path inside `cwd`, or null when the file is outside it. */
  readonly relativePath: string | null;
}): LiveSheet | null {
  const tx = useTx();
  const { environmentId, cwd, relativePath } = input;
  const capable =
    useServerConfigs().get(environmentId)?.environment.capabilities.documentSessions === true;
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const supported =
    capable && relativePath !== null && relativePath.toLowerCase().endsWith(SHEET_ARTIFACT_SUFFIX);
  const access = canWrite ? ("edit" as const) : ("view" as const);

  const sendUpdate = useAtomCommand(documentSession.update, { reportFailure: false });
  const sendPresence = useAtomCommand(documentSession.presence, { reportFailure: false });
  // A new key starts a new subscription: how a window starts over after a refusal.
  const [sessionKey, setSessionKey] = useState(newSessionKey);
  const latest = useRef({ sendUpdate, sendPresence, sessionKey, environmentId, cwd, relativePath });
  latest.current = { sendUpdate, sendPresence, sessionKey, environmentId, cwd, relativePath };

  const messages = {
    viewOnly: tx("This window can only view the sheet."),
    refused: tx("That change could not be made. The sheet is back to what everyone sees."),
    reloaded: tx(
      "The sheet was opened again from its file. An edit that was still on its way may be missing.",
    ),
  };
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // One store per file: it outlives a restart of the subscription.
  const store = useMemo(() => {
    void environmentId;
    void cwd;
    void relativePath;
    return new LiveSheetStore(
      {
        update: async (update) => {
          const now = latest.current;
          if (now.relativePath === null) return "failed";
          const result = await now.sendUpdate({
            environmentId: now.environmentId,
            input: {
              cwd: now.cwd,
              relativePath: now.relativePath,
              sessionKey: now.sessionKey,
              update,
            },
          });
          return result._tag === "Success"
            ? "merged"
            : sendResult(squashAtomCommandFailure(result));
        },
        presence: (place: DocumentSessionPlace | null) => {
          const now = latest.current;
          if (now.relativePath === null) return;
          void now.sendPresence({
            environmentId: now.environmentId,
            input: {
              cwd: now.cwd,
              relativePath: now.relativePath,
              sessionKey: now.sessionKey,
              place,
            },
          });
        },
        restart: () => setSessionKey(newSessionKey()),
      },
      {
        get viewOnly() {
          return messagesRef.current.viewOnly;
        },
        get refused() {
          return messagesRef.current.refused;
        },
        get reloaded() {
          return messagesRef.current.reloaded;
        },
      },
    );
  }, [environmentId, cwd, relativePath]);
  useEffect(() => () => store.dispose(), [store]);

  // The receiver is in place before the subscription starts, so no event is missed.
  const [listening, setListening] = useState<string | null>(null);
  useEffect(() => {
    if (!supported) return;
    const stop = receiveDocumentSession(sessionKey, (event) => store.receive(event));
    setListening(sessionKey);
    return () => {
      stop();
      setListening(null);
    };
  }, [sessionKey, store, supported]);

  const subscription = useEnvironmentQuery(
    supported && relativePath !== null && listening === sessionKey
      ? documentSession.open({ environmentId, input: { cwd, relativePath, sessionKey, access } })
      : null,
  );
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  const selfName = tx("You");
  const agentName = tx("Agent");
  const result = useMemo(() => {
    const presence = presenceEntries(state.participants, state.participantId, {
      self: selfName,
      window: (n) => tx("Window {n}", { n: String(n) }),
      agent: agentName,
    });
    return { state, presence, binding: liveSheetBinding(store, state, presence) };
  }, [agentName, selfName, state, store, tx]);

  // The machine could not open a session on this file: save by revision instead.
  if (!supported || subscription.failure !== null) return null;
  return result;
}
