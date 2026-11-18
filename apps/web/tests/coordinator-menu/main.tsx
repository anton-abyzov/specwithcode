/* Synthetic data only: the project "Atlas" on fictional machines m4, m5, m1 and linux-mini.
   Every menu row comes from records through the real resolvers (`orchestratorCopies`,
   `copyRoles`, `unloadedMachineRefs`), every "Continue here" from `makeMainPath` and
   `mainOffer`, and every message box from `coordinatorBoxState`.
   `?case=`
     menu      m5's page: m4 holds the coordinator, m5 handed it on, m1 started an extra
               coordinator at a higher epoch, linux-mini is listed but never opened here
     offline   m4 offline (last seen 2h ago), m5 kept its old conversation, linux-mini mid
               hand off
     unlinked  the same repository added on m1, m3 and m4 on its own (separate projects)
     fix       the Fix dialog for m1 (`&guard=1`: linux-mini still follows m1's coordinator;
               `&alone=1`: m1 is alone in its list; `&problem=permission`: m1 cannot be
               changed from this window)
     box       m5's message box, `&state=` routes | unloaded | not-ready |
               waiting | read-only | files | refused | moved | silent | silent-files
     switched  m5 after it continued the coordinator while m4 was offline
     settings  Settings > Machines label of a separate project
   `?theme=dark`, `?lang=` the interface language. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId } from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import {
  CoordinatorBlockedNotice,
  OfflineSwitchNotice,
} from "../../src/components/studio/CoordinatorBlockedNotice";
import { CoordinatorComposer } from "../../src/components/studio/CoordinatorComposer";
import { ExtraCoordinatorFix } from "../../src/components/studio/ExtraCoordinatorFix";
import {
  OrchestratorSwitcher,
  type MachineRowReach,
} from "../../src/components/studio/OrchestratorSwitcher";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { isLocale, setLocalePreference, useTx } from "../../src/i18n";
import { coordinatorBoxState } from "../../src/studio/coordinatorBoxState";
import { formatAgo } from "../../src/studio/hostLimitsModel";
import { mainOffer, makeMainPath, type MakeMainMachines } from "../../src/studio/makeMain";
import {
  keptCoordinatorCopies,
  orchestratorCopies,
  unloadedMachineRefs,
  type OrchestratorCopy,
} from "../../src/studio/projectCoordinatorMachine";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import {
  canRouteToMain,
  composerMachines,
  routeTarget,
  ROUTED_FILES_MESSAGE,
} from "../../src/studio/routeToMain";
import { workersOnlyProblem } from "../../src/studio/workersOnlyCopy";
import { buildMachineRows } from "../../src/components/settings/machinesSettings.logic";
import { applyThemePalette } from "../../src/themePalette";
import "./fixture.css";

const params = new URLSearchParams(location.search);
const dark = params.get("theme") === "dark";
document.documentElement.classList.toggle("dark", dark);
applyThemePalette("studio-chat", dark ? "dark" : "light");
const lang = params.get("lang");
if (lang && isLocale(lang)) setLocalePreference(lang);

const view = params.get("case") ?? "menu";
const PROJECT = "Atlas";
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

declare global {
  interface Window {
    /** Everything the page was asked to do, in order: views, fixes, continues, sends. */
    __events?: string[];
    __routed?: Array<{ environmentId: string; projectId: string; text: string }>;
    /** Moves the coordinator to another machine while a message is being typed. */
    __moveCoordinator?: (machine: string) => void;
    /** The message box's state for a set of conditions (`coordinatorBoxState`). */
    __boxKind?: (input: Record<string, unknown>) => string;
  }
}
const record = (event: string) => (window.__events ??= []).push(event);

// Records as the machines hold them.
const memberRef = (machine: string) => ({
  environmentId: machine,
  projectId: "p",
  coordinatorThreadId: "project-coordinator:p",
});
const ROSTER = ["m4", "linux-mini", "m5", "m1"];
const linkedRecord = (machine: string, binding: object, roster: readonly string[] = ROSTER) =>
  ({
    environmentId: machine,
    id: "p",
    title: PROJECT,
    workspaceRoot: "/w/atlas",
    workspaceSettings: {
      kind: "code",
      logicalProject: {
        id: "logical:atlas",
        title: PROJECT,
        coordinatorId: "coordinator:logical:atlas",
        members: roster.map(memberRef),
      },
      coordinatorBinding: binding,
    },
  }) as unknown as EnvironmentProject;
const separateRecord = (machine: string) =>
  ({
    environmentId: machine,
    id: "p",
    title: PROJECT,
    workspaceRoot: "/w/atlas",
    workspaceSettings: { kind: "code" },
  }) as unknown as EnvironmentProject;

// m4 holds the coordinator (m5 handed it to m4); m1 started its own at epoch 2, no predecessor.
const m4 = linkedRecord("m4", { epoch: 0, state: "active" });
const m5 = linkedRecord("m5", { epoch: 0, state: "transferred", successor: memberRef("m4") });
const m1 = linkedRecord("m1", { epoch: 2, state: "active", operationId: "op" });
// linux-mini mid hand off (offline case), or a machine that still follows m1 (Fix guard).
const linuxMoving = linkedRecord("linux-mini", { epoch: 0, state: "transferring" });
// m1 alone in its own list: not started beside the coordinator's machines, so it cannot leave.
const m1Alone = linkedRecord("m1", { epoch: 2, state: "active", operationId: "op" }, ["m1"]);
const linuxFollowsM1 = linkedRecord("linux-mini", {
  epoch: 0,
  state: "transferred",
  successor: memberRef("m1"),
});
const RECORDS: Record<string, EnvironmentProject[]> = {
  menu: [m4, m5, m1],
  // `unloaded`: this window never opened Atlas on m4 (nor on m1, whose own coordinator would
  // stand in for it); m5's own record still names m4 as its coordinator's successor.
  box: params.get("state") === "unloaded" ? [m5] : [m4, m5, m1],
  offline: [m4, m5, linuxMoving, m1],
  unlinked: ["m1", "m3", "m4"].map(separateRecord),
  fix:
    params.get("guard") === "1"
      ? [m4, m5, m1, linuxFollowsM1]
      : params.get("alone") === "1"
        ? [m4, m5, m1Alone]
        : [m4, m5, m1],
};
const records = RECORDS[view] ?? RECORDS.menu!;
const byKey = (key: string) => records.find((item) => `${item.environmentId}:${item.id}` === key);

/** The switcher's rows from the records: kept conversations only in the offline case. */
const copies: OrchestratorCopy[] = (() => {
  const kept = view === "offline";
  const listed = orchestratorCopies(
    records,
    (member) => member.environmentId,
    () => kept,
  );
  return kept ? keptCoordinatorCopies(listed, records, () => true) : listed;
})();
const unknown = unloadedMachineRefs(records).map((ref) => ({
  key: `${ref.environmentId}:${ref.projectId}`,
  machine: ref.environmentId,
}));
const reachOf = (key: string): MachineRowReach =>
  view === "offline" && key === "m4:p"
    ? { reach: "offline", lastSeen: formatAgo(NOW - 2 * 60 * MINUTE, NOW) }
    : { reach: "open" };

/** What the window knows of the machines, for one box state. */
interface BoxConditions {
  /** m5, the machine shown, is connected in this window. */
  /** This window has opened Atlas on m4, the coordinator's machine. */
  readonly mainLoaded: boolean;
  /** Minutes m4 has been silent; null while it answers. */
  readonly silentMinutes: number | null;
  /** m5 can take the coordinator over (new enough, permitted). */
  readonly takeoverReady: boolean;
  /** This window may run work on m4. */
  readonly mayOperate: boolean;
  readonly hasFiles: boolean;
  readonly movedTo: string | null;
  readonly refused: string | null;
}
const ANSWERS: BoxConditions = {
  mainLoaded: true,
  silentMinutes: null,
  takeoverReady: true,
  mayOperate: true,
  hasFiles: false,
  movedTo: null,
  refused: null,
};
const SILENT = ["waiting", "silent", "silent-files", "not-ready"];
/** Each box state of the page as conditions; files, moves and refusals come from the page. */
const conditionsFor = (state: string): BoxConditions => ({
  ...ANSWERS,
  mainLoaded: state !== "unloaded",
  silentMinutes: SILENT.includes(state) ? (state === "waiting" ? 3 : 12) : null,
  takeoverReady: state !== "not-ready",
  mayOperate: state !== "read-only",
});

/** The machines as `useMakeMain` sees them. */
const machinesOf = (input: BoxConditions): MakeMainMachines => ({
  connected: (id) => !(id === "m4" && input.silentMinutes !== null),
  unreachableSince: (id) =>
    id === "m4" && input.silentMinutes !== null ? NOW - input.silentMinutes * MINUTE : null,
  now: NOW,
  canMoveFrom: () => input.mayOperate,
  takeoverReady: () => input.takeoverReady,
});
const recordsOf = (input: BoxConditions) => (input.mainLoaded ? [m4, m5, m1] : [m5]);
const offerOf = (input: BoxConditions, main: string) =>
  mainOffer("m5:p", makeMainPath(m5, recordsOf(input), machinesOf(input)), {
    machine: "m5",
    main,
    project: PROJECT,
  });
const offerFor = (state: string, main: string) => offerOf(conditionsFor(state), main);
/** The box's state for `input`, through the same resolvers the page uses. */
function boxKindOf(partial: Partial<BoxConditions>) {
  const input = { ...ANSWERS, ...partial };
  const mainConnected = input.silentMinutes === null;
  return coordinatorBoxState({
    project: PROJECT,
    machine: "m4",
    routes: canRouteToMain({
      copyOff: true,
      target: routeTarget("m4:p"),
      mainLive: input.mainLoaded,
      mainConnected,
      mayOperate: input.mayOperate,
    }),
    machineConnected: mainConnected,
    mayOperate: input.mayOperate,
    hasFiles: input.hasFiles,
    movedTo: input.movedTo,
    refused: input.refused,
    offer: offerOf(input, "m4"),
  }).kind;
}
window.__boxKind = (input) => boxKindOf(input as Partial<BoxConditions>);

function Switcher({
  label,
  current,
  onView,
  offers,
  connected = true,
}: {
  connected?: boolean;
  label: string;
  current: string;
  onView: (key: string) => void;
  offers: ReturnType<typeof offerFor>[];
}) {
  const [fixKey, setFixKey] = useState<string | null>(null);
  const fixMember = fixKey ? byKey(fixKey) : undefined;
  return (
    <>
      <OrchestratorSwitcher
        identity={{ color: "teal" } as never}
        label={label}
        projectTitle={PROJECT}
        connected={connected}
        statusDetail=""
        current={current}
        copies={copies}
        unknown={unknown}
        savedMachineMissing={false}
        reachOf={reachOf}
        onView={(key) => {
          record(`view:${key}`);
          onView(key);
        }}
        mainOffers={offers.flatMap((offer) => offer ?? [])}
        onMakeMain={(key) => record(`continue:${key}`)}
        onFix={(key) => {
          record(`fix:${key}`);
          setFixKey(key);
        }}
        onAllowWorkers={() => record("connect")}
        onMigrate={() => record("migrate")}
        onCopy={() => record("send-to-machine")}
        onLeave={() => record("leave")}
        links={
          view === "unlinked"
            ? copies
                .filter((item) => item.key !== current)
                .map(({ key, machine }) => ({ key, machine }))
            : []
        }
        onLink={view === "unlinked" ? (key) => record(`link:${key}`) : null}
      />
      {fixMember ? (
        <ExtraCoordinatorFix
          member={fixMember}
          coordinator={m4}
          shared={records}
          projectTitle={PROJECT}
          onClose={() => setFixKey(null)}
        />
      ) : null}
    </>
  );
}

/** The machine menu on its own, on the page of the machine it starts on. */
function MenuPage() {
  const start = view === "unlinked" ? "m4:p" : "m5:p";
  const [current, setCurrent] = useState(start);
  const shown = current.split(":")[0]!;
  return (
    <div className="fixture-page" data-viewing={current}>
      <Switcher
        label={shown}
        current={current}
        onView={setCurrent}
        offers={view === "menu" || view === "offline" ? [offerFor("routes", "m4")] : []}
      />
    </div>
  );
}

function FixPage() {
  return (
    <div className="fixture-page" data-fix-page="">
      <ExtraCoordinatorFix
        member={params.get("alone") === "1" ? m1Alone : m1}
        coordinator={m4}
        shared={records}
        projectTitle={PROJECT}
        onOpenSettings={() => record("open-settings")}
        onClose={() => record("fix-closed")}
      />
    </div>
  );
}

const footControls = (
  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
    <span className="truncate">Opus 5.5</span>
    <span className="shrink-0">Full access</span>
  </span>
);

/**
 * m5's page, wired as `ProjectWorkspaceSurface` wires its message box (`useCoordinatorBox`):
 * the box's state from `coordinatorBoxState`, Send routed to the coordinator's machine, and
 * "Continue here and send" that continues the coordinator here, then sends locally once this
 * page shows the coordinator here. Nothing is queued.
 */
function BoxPage() {
  const tx = useTx();
  const state = params.get("state") ?? "routes";
  const [current, setCurrent] = useState("m5:p");
  // The coordinator's machine; "moved" moves it while a message is typed.
  const [main, setMain] = useState("m4");
  // The coordinator continued on m5 ("Continue here").
  const [continued, setContinued] = useState(false);
  window.__moveCoordinator = setMain;
  const composer = getProjectCoordinatorComposer(EnvironmentId.make("m5"), "atlas-box");
  const viewed = current.split(":")[0]!;
  const coordinatorHere = continued ? viewed === "m5" : viewed === main;
  const copyOff = !coordinatorHere;
  const mainKey = copyOff ? (continued ? "m5:p" : `${main}:p`) : null;
  const hasFiles = useSyncExternalStore(
    composer.subscribe,
    () => composer.getSnapshot().attachments.length > 0,
  );
  const hasText = useSyncExternalStore(
    composer.subscribe,
    () => composer.getSnapshot().prompt.trim().length > 0,
  );
  useEffect(() => {
    if (state === "files" || state === "silent-files")
      composer.setAttachments([
        {
          type: "file",
          id: "notes",
          name: "notes.pdf",
          mimeType: "application/pdf",
          sizeBytes: 6,
          file: new File(["report"], "notes.pdf", { type: "application/pdf" }),
        },
      ] as never);
  }, [composer, state]);
  // The same rule as the hook: the coordinator moved while this draft held text.
  const [seenKey, setSeenKey] = useState(mainKey);
  const [moved, setMoved] = useState(false);
  if (seenKey !== mainKey) {
    setSeenKey(mainKey);
    setMoved(seenKey !== null && mainKey !== null && hasText);
  } else if (moved && !hasText) setMoved(false);

  const conditions = conditionsFor(state);
  // What the coordinator's machine said when it refused the last send (the hook's rule).
  const [refusal, setRefusal] = useState<{ key: string | null; reason: string } | null>(null);
  const mainConnected = conditions.silentMinutes === null;
  const mayOperate = conditions.mayOperate;
  const routes = canRouteToMain({
    copyOff,
    target: routeTarget(mainKey),
    mainLive: conditions.mainLoaded,
    mainConnected,
    mayOperate,
  });
  const offer = copyOff && viewed === "m5" ? offerFor(state, main) : null;
  const box = copyOff
    ? coordinatorBoxState({
        project: PROJECT,
        machine: main,
        routes,
        machineConnected: mainConnected,
        mayOperate,
        hasFiles,
        movedTo: moved ? main : null,
        refused: refusal && refusal.key === mainKey ? refusal.reason : null,
        offer,
      })
    : null;
  // A text waiting for the coordinator to run here after "Continue here and send".
  const waiting = useRef<{ readonly text: string; readonly done: () => void } | null>(null);
  useEffect(() => {
    const held = waiting.current;
    if (!coordinatorHere || held === null) return;
    waiting.current = null;
    record(`send-here:${held.text}`);
    held.done();
  }, [coordinatorHere]);
  const continueHere = offer
    ? () => {
        record(`continue:${offer.key}`);
        setContinued(true);
      }
    : null;
  const send = async (text: string, files?: readonly unknown[]) => {
    setRefusal(null);
    if (!box) {
      record(`send-here:${text}`);
      return;
    }
    if (box.send.continues) {
      if (!continueHere) throw new Error(tx("Nothing was sent."));
      if (files?.length) {
        continueHere();
        throw new Error(tx("The coordinator continues here. Send your message again."));
      }
      // The continued coordinator takes the text once it shows here; the box keeps it until then.
      await new Promise<void>((done) => {
        waiting.current = { text, done };
        continueHere();
      });
      return;
    }
    const target = routeTarget(mainKey);
    if (!routes || !target || !mainKey)
      throw new Error(tx("The coordinator's machine is not reachable from here."));
    if (files?.length)
      throw new Error(tx(ROUTED_FILES_MESSAGE, { project: PROJECT, machine: main }));
    if (state === "refused") {
      // m4 is asked and does not take the message: the text stays in the box.
      record(`refused:${target.environmentId}:${text}`);
      setRefusal({ key: mainKey, reason: "The coordinator is answering another message." });
      throw new Error("The coordinator is answering another message.");
    }
    (window.__routed ??= []).push({ ...target, text });
    record(`routed:${target.environmentId}:${text}`);
    setMoved(false);
    setCurrent(mainKey);
  };
  const named = composerMachines({ viewed, mainKey, routes });
  return (
    <div
      className="fixture-page fixture-column"
      data-viewing={current}
      data-coordinator-here={coordinatorHere ? "" : undefined}
    >
      <div className="project-conversation">
        <article className="mb-3 rounded-lg border border-border p-3 text-sm">
          The release notes for {PROJECT} are drafted. Two threads are still running.
        </article>
      </div>
      <CoordinatorComposer
        composer={composer}
        threadRef={null}
        // The box wears the machine the chip names: the one shown.
        environmentId={EnvironmentId.make(viewed)}
        cwd="/w/atlas"
        sendBlocked={box ? !box.send.enabled : false}
        missingModel={null}
        canAttach={!routes}
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder={
          box
            ? tx(box.placeholder.text, box.placeholder.values)
            : "Ask the coordinator a question or start a task…"
        }
        hostReachable
        primary={
          box?.send.continues
            ? {
                text: tx(box.send.text),
                ...(hasFiles && continueHere ? { run: continueHere } : {}),
              }
            : null
        }
        sendTo={
          routes
            ? {
                machine: main,
                tip: tx("Goes to the coordinator on {machine} and opens it there", {
                  machine: main,
                }),
              }
            : null
        }
        promptLabel="Message the project coordinator"
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={send}
        onError={(message) => {
          if (message) record(`error:${message}`);
        }}
        status={
          box ? (
            <CoordinatorBlockedNotice
              text={workersOnlyProblem(main, false, PROJECT)}
              box={box}
              coordinatorKey={mainKey}
              onContinue={continueHere}
            />
          ) : null
        }
        notices={null}
        meta={
          <Switcher
            label={named.chip}
            connected
            current={current}
            onView={setCurrent}
            offers={offer ? [offer] : []}
          />
        }
        controls={footControls}
        modelFallback={false}
      />
    </div>
  );
}

/** m5 after it continued the coordinator while m4 was offline. */
function SwitchedPage() {
  return (
    <div className="fixture-page fixture-column" data-viewing="m5:p">
      <div className="project-conversation">
        <article className="mb-3 rounded-lg border border-border p-3 text-sm">
          The coordinator for {PROJECT} runs here now.
        </article>
      </div>
      <CoordinatorComposer
        composer={getProjectCoordinatorComposer(EnvironmentId.make("m5"), "atlas-switched")}
        threadRef={null}
        environmentId={EnvironmentId.make("m5")}
        cwd="/w/atlas"
        sendBlocked={false}
        missingModel={null}
        canAttach
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder="Ask the coordinator a question or start a task…"
        hostReachable
        promptLabel="Message the project coordinator"
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={async () => {}}
        onError={() => {}}
        status={<OfflineSwitchNotice id="m5:p:fixture-switch" machine="m5" previous="m4" />}
        notices={null}
        meta={<Switcher label="m5" current="m5:p" onView={() => {}} offers={[]} />}
        controls={footControls}
        modelFallback={false}
      />
    </div>
  );
}

function SettingsLabel() {
  const tx = useTx();
  const identity = (rootPath: string) =>
    ({
      canonicalKey: "github.com/example/atlas",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/atlas.git",
      },
      rootPath,
    }) as never;
  const rows = buildMachineRows({
    environments: ["m4", "m3"].map((environmentId) => ({
      environmentId: EnvironmentId.make(environmentId),
      label: environmentId,
      phase: "connected",
      statusText: "Connected",
    })),
    primaryEnvironmentId: EnvironmentId.make("m4"),
    fleet: null,
    canPair: false,
    projects: ["m4", "m3"].map((machine) => ({
      environmentId: EnvironmentId.make(machine),
      id: `p-${machine}`,
      title: PROJECT,
      workspaceRoot: "/w/atlas",
      repositoryIdentity: identity("/w/atlas"),
    })),
    hostBlocks: [],
  });
  const project = rows[0]?.projects.own[0];
  return (
    <div className="fixture-page" data-settings-label>
      <p>{PROJECT}</p>
      <p data-role-label>{project ? tx(project.roleLabel, project.roleValues) : ""}</p>
    </div>
  );
}

function Page() {
  if (view === "settings") return <SettingsLabel />;
  if (view === "fix") return <FixPage />;
  if (view === "box") return <BoxPage />;
  if (view === "switched") return <SwitchedPage />;
  return <MenuPage />;
}

const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute({
    component: () => (
      <ToastProvider>
        <AnchoredToastProvider>
          <TooltipProvider>
            <Page />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
