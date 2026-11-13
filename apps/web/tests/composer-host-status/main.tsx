/* Synthetic data only: a project page's coordinator column while the machine that
   runs it comes and goes. The real CoordinatorComposer, Runs on chip, voice menu and
   blocked-host text, wired as ProjectWorkspaceSurface wires them.
   `?state=` online | offline | reconnecting | connecting | signed-out | this-device
   `?name=` the viewed machine's name, `?theme=dark`, `?width=` the column in px,
   `?lang=` the interface language, `?synced=` minutes since this device last synced
   it (`unknown` for never). `window.__setState(state)` moves it without a reload. */
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId } from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import { CoordinatorComposer } from "../../src/components/studio/CoordinatorComposer";
import { CoordinatorBlockedNotice } from "../../src/components/studio/CoordinatorBlockedNotice";
import { ProjectComposerHostStatus } from "../../src/components/studio/ComposerHostStatus";
import { ComposerVoiceMenu } from "../../src/components/studio/ComposerVoiceMenu";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import {
  composerHostStatus,
  hostDisconnectedLabel,
  projectAdmissionReason,
  remoteOrchestratorOfflineLabel,
} from "../../src/studio/projectWorkspaceModel";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import { isLocale, setLocalePreference, useTx } from "../../src/i18n";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

const NOW = Date.parse("2026-11-13T18:00:00Z");
Date.now = () => NOW;
const synced = params.get("synced");
window.__lastSyncedAt = synced === "unknown" ? null : NOW - Number(synced ?? 0) * 60_000;
// `?view=this-mac`: Runs on switched to this device's own copy, which is connected.
const viewThis = params.get("view") === "this-mac";
const machine = viewThis ? "M4 Max" : (params.get("name") ?? "linux-mini");
window.__fixtureMachine = machine;

type FixtureState =
  | "online"
  | "offline"
  | "reconnecting"
  | "connecting"
  | "signed-out"
  | "this-device";
declare global {
  interface Window {
    __setState?: (state: FixtureState) => void;
    __sent?: string[];
  }
}

const environmentId = EnvironmentId.make(viewThis ? "this-mac" : "linux-mini-env");
const composer = getProjectCoordinatorComposer(environmentId, "specweave");
const SETTINGS = { paused: false, archived: false };

function connectionOf(state: FixtureState) {
  switch (state) {
    case "online":
      return { phase: "connected" } as const;
    case "reconnecting":
      return { phase: "reconnecting" } as const;
    case "connecting":
      return { phase: "connecting" } as const;
    case "signed-out":
      return { phase: "error", blockedReason: "authentication" } as const;
    case "this-device":
      return { phase: "reconnecting" } as const;
    default:
      return { phase: "error" } as const;
  }
}

const dictation = {
  available: true,
  active: false,
  phase: "idle",
  start: () => {},
  stop: () => {},
  consentOpen: false,
} as never;
const call = {
  available: true,
  active: false,
  unavailableReason: null,
  start: () => {},
  end: () => {},
  consentOpen: false,
} as never;

function Harness() {
  const [state, setState] = useState<FixtureState>(
    viewThis ? "online" : ((params.get("state") as FixtureState | null) ?? "offline"),
  );
  useEffect(() => {
    window.__setState = setState;
  }, []);
  const connection = connectionOf(state);
  const connected = connection.phase === "connected";
  const isThisDevice = state === "this-device";
  const hostAdmission = { isThisDevice, graceElapsed: true };
  const admission = projectAdmissionReason(SETTINGS, connected, true, connection as never, {
    ...hostAdmission,
    machineLabel: machine,
  });
  const blocked = admission;
  const hostStatus = connected
    ? null
    : composerHostStatus(connection as never, { ...hostAdmission, machineLabel: machine });
  const tx = useTx();
  const statusDetail = isThisDevice
    ? hostDisconnectedLabel(connection as never, hostAdmission)
    : remoteOrchestratorOfflineLabel(machine, window.__lastSyncedAt ?? null, NOW);
  const width = params.get("width");
  return (
    <div
      className="fixture-page"
      data-fixture-state={state}
      style={width ? { maxWidth: `${width}px` } : undefined}
    >
      <div className="project-conversation">
        <article className="mb-3 rounded-lg border border-border p-3 text-sm">
          The release notes are drafted. Two threads are still running on {machine}.
        </article>
      </div>
      <CoordinatorComposer
        composer={composer}
        threadRef={null}
        environmentId={environmentId}
        cwd="/workspace/specweave"
        sendBlocked={Boolean(blocked)}
        missingModel={null}
        canAttach={connected}
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder={
          hostStatus?.showsSync && hostStatus.machine
            ? tx("Your draft stays here until it reconnects.")
            : "Ask the coordinator a question or start a task…"
        }
        hostReachable={connected}
        promptLabel="Message the project coordinator"
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={async (text) => {
          (window.__sent ??= []).push(text);
        }}
        onError={() => {}}
        status={
          hostStatus ? (
            <ProjectComposerHostStatus status={hostStatus} environmentId={environmentId} />
          ) : blocked ? (
            <CoordinatorBlockedNotice
              text={blocked}
              coordinator={null}
              current="linux-mini-env:specweave"
              members={[]}
              copies={[]}
              onOpen={null}
            />
          ) : null
        }
        notices={null}
        meta={
          <>
            <OrchestratorSwitcher
              identity={{ color: "teal" } as never}
              label={machine}
              connected={connected}
              statusDetail={statusDetail}
              current={viewThis ? "this-mac:specweave" : "linux-mini-env:specweave"}
              copies={[
                {
                  key: "linux-mini-env:specweave",
                  machine: viewThis ? (params.get("name") ?? "linux-mini") : machine,
                  folder: "/workspace/specweave",
                  role: "coordinator",
                  canStart: false,
                },
                {
                  key: "this-mac:specweave",
                  machine: "M4 Max",
                  folder: "/Users/me/specweave",
                  role: "workers",
                  canStart: true,
                },
              ]}
              unknown={[]}
              savedMachineMissing={false}
              onView={() => {}}
              onMove={null}
              onStart={null}
              onAllowWorkers={null}
            />
            <ComposerVoiceMenu
              dictation={dictation}
              call={call}
              callDisabled={Boolean(blocked)}
              shortcut={null}
            />
            <button type="button" className="sws-state" data-tone="idle">
              <span className="sws-dot" data-tone="idle" aria-hidden />
              Idle
            </button>
          </>
        }
        controls={
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">Claude Code · Opus 5.5</span>
            <span className="shrink-0">Full access</span>
          </span>
        }
        modelFallback={false}
      />
    </div>
  );
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
