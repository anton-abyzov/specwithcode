/**
 * Runs the approved Studio Mods of the primary environment, each in its own
 * sandboxed frame, and turns their checked messages into workbench UI:
 * command palette entries, sidebar status, toasts and panes.
 */
import type { EnvironmentId, ModEntry, ModSpecweaveResult } from "@specweave-studio/contracts";
import { AuthOrchestrationReadScope } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useProjects, useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { deriveSessions } from "../studio/overviewModel";
import { ModPanes } from "./ModPanes";
import { useModsStore } from "./modsStore";
import { decideModRequest, parseFrameMessage, ToastBudget } from "./protocol";
import { buildModSrcdoc, MOD_FRAME_SANDBOX } from "./sandbox";

/** What a mod with `threads:read` sees of each session: no messages, no paths. */
export interface ModThreadSummary {
  readonly id: string;
  readonly title: string;
  readonly project: string | null;
  readonly state: string;
  readonly attention: string | null;
  readonly working: boolean;
  readonly updatedAt: string | null;
}

/**
 * Whether the environment's server knows Studio Mods. "unknown" until its
 * config arrives; a server from before Mods never advertises the capability,
 * and asking it for `mods.list` only fails with a generic error.
 */
export function useModsSupport(environmentId: EnvironmentId | null): {
  readonly support: "unknown" | "supported" | "unsupported";
  readonly serverVersion: string | null;
} {
  const configs = useServerConfigs();
  const config = environmentId === null ? undefined : configs.get(environmentId);
  if (config === undefined) {
    return { support: "unknown", serverVersion: null };
  }
  return {
    support: config.environment.capabilities.studioMods === true ? "supported" : "unsupported",
    serverVersion: config.environment.serverVersion,
  };
}

export function useModsList(environmentId: EnvironmentId | null) {
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const { support } = useModsSupport(environmentId);
  return useEnvironmentQuery(
    environmentId === null || !canRead || support !== "supported"
      ? null
      : serverEnvironment.modsList({ environmentId, input: {} }),
  );
}

function useThreadSummaries(environmentId: EnvironmentId, enabled: boolean) {
  const shells = useThreadShells(enabled);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const connected = environments.some(
    (environment) =>
      environment.environmentId === environmentId && environment.connection.phase === "connected",
  );
  return useMemo((): ReadonlyArray<ModThreadSummary> => {
    if (!enabled) return [];
    const own = shells.filter((thread) => thread.environmentId === environmentId);
    return deriveSessions(own, projects, connected ? new Set([environmentId]) : new Set())
      .slice(0, 200)
      .map((session) => ({
        id: session.thread.id,
        title: session.thread.title || "Untitled session",
        project: session.project?.title ?? null,
        state: session.state,
        attention: session.attention,
        working: session.working,
        updatedAt: session.thread.updatedAt ?? null,
      }));
  }, [connected, enabled, environmentId, projects, shells]);
}

/** How often a mod with `specweave:read` re-reads increments while it runs. */
const SPECWEAVE_REFRESH_MS = 30_000;

/**
 * The read-only SpecWeave summary for mods with `specweave:read`, re-read on
 * an interval. Mods never choose what is read: the request takes no input.
 */
function useSpecweaveSummary(environmentId: EnvironmentId, enabled: boolean) {
  const configs = useServerConfigs();
  const supported =
    configs.get(environmentId)?.environment.capabilities.studioModsSpecweave === true;
  const active = enabled && supported;
  const { data, error, refresh } = useEnvironmentQuery(
    active ? serverEnvironment.modsSpecweave({ environmentId, input: {} }) : null,
  );
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(refresh, SPECWEAVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  return { supported, data, failed: data === null && error !== null };
}

const SPECWEAVE_UNAVAILABLE = "Could not read SpecWeave progress on this host.";

function ModFrame({ environmentId, mod }: { environmentId: EnvironmentId; mod: ModEntry }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const startedRef = useRef(false);
  const lastUserActionAtRef = useRef<number | null>(null);
  const toastBudgetRef = useRef(new ToastBudget());
  const navigate = useNavigate();
  // Refs keep the frame's listener stable across list refreshes, which return
  // new arrays for the same approved contents.
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const permissionsRef = useRef(mod.permissions);
  permissionsRef.current = mod.permissions;
  const canReadThreads = mod.permissions.includes("threads:read");
  const threads = useThreadSummaries(environmentId, canReadThreads);
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const canReadSpecweave = mod.permissions.includes("specweave:read");
  const specweave = useSpecweaveSummary(environmentId, canReadSpecweave);
  const specweaveRef = useRef(specweave);
  specweaveRef.current = specweave;
  // specweave.list calls that arrived before the first summary; answered once it does.
  const waitingSpecweaveRef = useRef<number[]>([]);
  const sentSpecweaveRef = useRef<ModSpecweaveResult | null>(null);
  const srcDoc = useMemo(() => buildModSrcdoc(mod.source ?? ""), [mod.source]);
  const name = mod.name;
  // The frame loads its document once. Any later load means it navigated,
  // which no mod should do: stop it rather than trust what it loaded.
  const loadsRef = useRef(0);
  const [stopped, setStopped] = useState(false);

  useEffect(() => {
    const frame = frameRef.current;
    const store = useModsStore.getState();
    const post = (message: unknown) => frame?.contentWindow?.postMessage(message, "*");
    const userActed = () => {
      lastUserActionAtRef.current = Date.now();
    };
    store.attach(name, {
      runCommand: (command) => {
        userActed();
        post({ type: "event", event: "command.run", e: { name: command } });
      },
      press: (paneId, handler) => {
        userActed();
        post({ type: "press", id: paneId, handler });
      },
      closePane: (paneId) => {
        useModsStore.getState().closePane(name, paneId);
        post({ type: "pane.closed", id: paneId });
      },
    });

    const respond = (
      requestId: number,
      result: { ok: true; value: unknown } | { ok: false; error: string },
    ) => post({ type: "response", requestId, ...result });

    const onMessage = (event: MessageEvent) => {
      // Opaque-origin frames post with origin "null"; identity is the window.
      if (frame === null || event.source !== frame.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (message === null) return;
      const state = useModsStore.getState();
      switch (message.type) {
        case "loaded":
          post({
            type: "init",
            name,
            surface: isElectron ? "desktop" : "web",
            permissions: permissionsRef.current,
          });
          return;
        case "started":
          startedRef.current = true;
          if (canReadThreads) {
            post({ type: "event", event: "threads.changed", e: { threads: threadsRef.current } });
          }
          if (canReadSpecweave && specweaveRef.current.data !== null) {
            sentSpecweaveRef.current = specweaveRef.current.data;
            post({ type: "event", event: "specweave.changed", e: specweaveRef.current.data });
          }
          return;
        case "error":
          state.setError(name, message.message);
          return;
        case "command.register":
          state.addCommand({ mod: name, name: message.name, description: message.description });
          return;
        case "ui.toast":
          if (toastBudgetRef.current.take(Date.now())) {
            toastManager.add({ type: "info", title: name, description: message.text });
          }
          return;
        case "ui.status":
          state.setStatus(name, message.text);
          return;
        case "ui.open":
          state.openPane(name, message.id, message.title);
          return;
        case "ui.close":
          state.closePane(name, message.id);
          return;
        case "ui.tree":
          state.setPaneTree(name, message.id, message.tree);
          return;
        case "request": {
          const decision = decideModRequest({
            method: message.method,
            permissions: permissionsRef.current,
            lastUserActionAt: lastUserActionAtRef.current,
            now: Date.now(),
          });
          if (!decision.allowed) {
            respond(message.requestId, { ok: false, error: decision.reason ?? "Not allowed." });
            return;
          }
          if (message.method === "threads.list") {
            respond(message.requestId, { ok: true, value: threadsRef.current });
            return;
          }
          if (message.method === "specweave.list") {
            const current = specweaveRef.current;
            if (!current.supported) {
              respond(message.requestId, {
                ok: false,
                error: "This Studio service predates SpecWeave access for mods. Update it first.",
              });
            } else if (current.data !== null) {
              respond(message.requestId, { ok: true, value: current.data });
            } else if (current.failed) {
              respond(message.requestId, { ok: false, error: SPECWEAVE_UNAVAILABLE });
            } else {
              waitingSpecweaveRef.current.push(message.requestId);
            }
            return;
          }
          const threadId = message.threadId;
          if (!threadsRef.current.some((thread) => thread.id === threadId) || threadId === null) {
            respond(message.requestId, { ok: false, error: "No such thread on this host." });
            return;
          }
          lastUserActionAtRef.current = null;
          void navigateRef.current({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId },
          });
          respond(message.requestId, { ok: true, value: null });
          return;
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      startedRef.current = false;
      useModsStore.getState().detach(name);
    };
  }, [canReadSpecweave, canReadThreads, environmentId, name]);

  // Mods with specweave:read hear about each new summary once, and get the
  // answer to any specweave.list call made before the first one arrived, or
  // an error if the first read failed, so the call never hangs.
  useEffect(() => {
    const data = specweave.data;
    const frameWindow = frameRef.current?.contentWindow;
    if (!canReadSpecweave || !frameWindow) return;
    if (data === null) {
      if (!specweave.failed) return;
      for (const requestId of waitingSpecweaveRef.current.splice(0)) {
        frameWindow.postMessage(
          { type: "response", requestId, ok: false, error: SPECWEAVE_UNAVAILABLE },
          "*",
        );
      }
      return;
    }
    for (const requestId of waitingSpecweaveRef.current.splice(0)) {
      frameWindow.postMessage({ type: "response", requestId, ok: true, value: data }, "*");
    }
    if (!startedRef.current || sentSpecweaveRef.current === data) return;
    if (JSON.stringify(sentSpecweaveRef.current) === JSON.stringify(data)) return;
    sentSpecweaveRef.current = data;
    frameWindow.postMessage({ type: "event", event: "specweave.changed", e: data }, "*");
  }, [canReadSpecweave, specweave.data, specweave.failed]);

  // Mods with threads:read follow session changes, at most twice a second.
  useEffect(() => {
    if (!canReadThreads || !startedRef.current) return;
    const timer = window.setTimeout(() => {
      frameRef.current?.contentWindow?.postMessage(
        { type: "event", event: "threads.changed", e: { threads } },
        "*",
      );
    }, 500);
    return () => window.clearTimeout(timer);
  }, [canReadThreads, threads]);

  if (stopped) return null;
  return (
    <iframe
      ref={frameRef}
      title={`SpecWithCode mod ${name}`}
      sandbox={MOD_FRAME_SANDBOX}
      srcDoc={srcDoc}
      onLoad={() => {
        loadsRef.current += 1;
        if (loadsRef.current > 1) {
          const store = useModsStore.getState();
          store.detach(name);
          store.setError(name, "Stopped: the mod tried to leave its sandbox.");
          setStopped(true);
        }
      }}
      referrerPolicy="no-referrer"
      aria-hidden
      tabIndex={-1}
      className="hidden"
    />
  );
}

export function ModsHost() {
  const environmentId = usePrimaryEnvironmentId();
  const { data } = useModsList(environmentId);
  const approved = (data?.mods ?? []).filter(
    (mod) => mod.status === "approved" && mod.source !== undefined,
  );
  if (environmentId === null) return null;
  return (
    <>
      {approved.map((mod) => (
        <ModFrame key={`${mod.name}:${mod.sha256}`} environmentId={environmentId} mod={mod} />
      ))}
      <ModPanes />
    </>
  );
}
