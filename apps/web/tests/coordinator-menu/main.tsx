/* Synthetic data only: one project on fictional machines, and the two places that switch
   its main. m4 is main; m5 and linux-mini are linked copies (linux-mini kept a
   conversation from before).
   `?view=m5` the page of that copy, `?main=` connected | lost | gone (the old main is
   reachable, lost under 10 minutes ago, or unreachable for longer),
   `?case=` menu | box | switched | unlinked | m5: the machine menu, a copy's message box (the
   real CoordinatorComposer), m5 after an offline switch, three checkouts of one
   repository that were never linked, and m5's page worked out by the real resolver from
   records shaped like the M5 state of November 17, 2026 (m1 started a coordinator beside
   main at a higher epoch). `?theme=dark`, `?lang=` the interface language. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { EnvironmentId } from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import {
  CoordinatorBlockedNotice,
  OfflineSwitchNotice,
} from "../../src/components/studio/CoordinatorBlockedNotice";
import { CoordinatorComposer } from "../../src/components/studio/CoordinatorComposer";
import { OrchestratorSwitcher } from "../../src/components/studio/OrchestratorSwitcher";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { ToastProvider, AnchoredToastProvider } from "../../src/components/ui/toast";
import { isLocale, setLocalePreference, useTx } from "../../src/i18n";
import {
  followedMain,
  mainOffer,
  makeMainPath,
  type MainOffer,
  type MakeMainPath,
} from "../../src/studio/makeMain";
import { composerMachines, routeTarget } from "../../src/studio/routeToMain";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
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
const reach = params.get("main") ?? "connected";
const PROJECT = "Atlas";

const copy = (
  machine: string,
  role: "main" | "copy" | "unlinked",
  main = "m4",
  canStart = false,
): OrchestratorCopy => ({
  key: `${machine}:p`,
  machine,
  folder: "/w/atlas",
  role: role === "main" ? "coordinator" : role === "copy" ? "workers" : "independent",
  main: role === "main",
  label:
    role === "main"
      ? { text: "Main" }
      : role === "copy"
        ? { text: "Copy · main on {machine}", values: { machine: main } }
        : { text: "not linked" },
  canStart,
});
const linked = [copy("m4", "main"), copy("m5", "copy"), copy("linux-mini", "copy", "m4", true)];
// m5 took over while m4 was unreachable: m5 is main, and m4 has not given way yet.
const switched = [copy("m5", "main"), copy("m4", "copy", "m5"), copy("linux-mini", "copy", "m5")];
// The same repository registered on three machines, never linked.
const unlinked = ["m1", "m3", "m4"].map((machine) => copy(machine, "unlinked"));
const copies = view === "unlinked" ? unlinked : view === "switched" ? switched : linked;

/** The switch each linked copy has, as `useMakeMain` works it out from the old main's reach. */
const path: MakeMainPath<never> =
  reach === "gone"
    ? { kind: "takeover", main: {} as never }
    : reach === "lost"
      ? { kind: "blocked", main: {} as never, reason: "waiting", waitMs: 7 * 60_000 }
      : { kind: "move", main: {} as never };
const offers: MainOffer[] =
  view === "menu" || view === "box"
    ? linked
        .filter((item) => !item.main)
        .flatMap((item) => mainOffer(item.key, path, { machine: item.machine, main: "m4" }) ?? [])
    : [];

declare global {
  interface Window {
    __madeMain?: string[];
    __routed?: Array<{ environmentId: string; projectId: string; text: string }>;
  }
}

// Records as the machines hold them: m4 is main at epoch 0 and m5 handed main to it; m1
// joined earlier, then started its own coordinator (epoch 2, no predecessor) and never
// learned of m5.
const memberRef = (machine: string) => ({
  environmentId: machine,
  projectId: "p",
  coordinatorThreadId: "project-coordinator:p",
});
const record = (machine: string, binding: object, roster: readonly string[]) =>
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
const records = [
  record("m4", { epoch: 0, state: "active" }, ["m4", "linux-mini", "m5"]),
  record("m5", { epoch: 0, state: "transferred", successor: memberRef("m4") }, [
    "m4",
    "linux-mini",
    "m5",
  ]),
  record("m1", { epoch: 2, state: "active", operationId: "op" }, ["m4", "linux-mini", "m1"]),
];
const m5Path = makeMainPath(records[1]!, records, {
  connected: () => true,
  unreachableSince: () => null,
  now: 0,
  canMoveFrom: () => true,
  takeoverReady: () => true,
});
const m5Main = followedMain(records[1]!, records)?.environmentId ?? "none";
const m5MoveSource = m5Path.kind === "move" ? m5Path.main.environmentId : m5Path.kind;
const m5Offer = mainOffer("m5:p", m5Path, { machine: "m5", main: m5MoveSource });

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
    projects: [
      {
        environmentId: EnvironmentId.make("m4"),
        id: "p-m4",
        title: PROJECT,
        workspaceRoot: "/w/atlas",
        repositoryIdentity: identity("/w/atlas"),
      },
      {
        environmentId: EnvironmentId.make("m3"),
        id: "p-m3",
        title: PROJECT,
        workspaceRoot: "/w/atlas",
        repositoryIdentity: identity("/w/atlas"),
      },
    ],
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
  const tx = useTx();
  if (view === "settings") return <SettingsLabel />;
  const start =
    view === "switched" ? "m5:p" : `${params.get("view") ?? (view === "box" ? "m5" : "m4")}:p`;
  const [current, setCurrent] = useState(start);
  const viewed = copies.find((item) => item.key === current)!;
  const makeMain = (key: string) => (window.__madeMain ??= []).push(key);
  const switcherNamed = (label: string) => (
    <OrchestratorSwitcher
      identity={{ color: "teal" } as never}
      label={label}
      connected
      statusDetail=""
      current={current}
      copies={copies}
      unknown={[]}
      savedMachineMissing={false}
      onView={setCurrent}
      mainOffers={offers}
      onMakeMain={makeMain}
      onAllowWorkers={() => {}}
      onMigrate={() => {}}
      onCopy={() => {}}
      onLeave={() => {}}
      links={
        view === "unlinked"
          ? unlinked
              .filter((item) => item.key !== current)
              .map(({ key, machine }) => ({ key, machine }))
          : []
      }
      onLink={view === "unlinked" ? () => {} : null}
    />
  );
  const switcher = switcherNamed(viewed.machine);
  if (view === "m5") {
    const routed = routeTarget(`${m5Main}:p`);
    // The page's own rule names the chip and Send (`composerMachines`), as on the M5.
    const named = composerMachines({
      viewed: "m5",
      mainKey: `${m5Main}:p`,
      copyOff: true,
      routes: true,
    });
    return (
      <div
        className="fixture-page fixture-column"
        data-viewing="m5:p"
        data-move-source={m5MoveSource}
        data-followed-main={m5Main}
      >
        <div className="project-conversation">
          <article className="mb-3 rounded-lg border border-border p-3 text-sm">
            This copy of {PROJECT} runs on m5.
          </article>
        </div>
        <CoordinatorComposer
          composer={getProjectCoordinatorComposer(EnvironmentId.make("m5"), "atlas-m5")}
          threadRef={null}
          environmentId={EnvironmentId.make(named.send ?? "m5")}
          cwd="/w/atlas"
          sendBlocked={false}
          missingModel={null}
          canAttach={false}
          uploadsSupported
          maxFileBytes={20 * 1024 * 1024}
          sending={false}
          placeholder={tx("Message {machine}'s coordinator for {project}.", {
            project: PROJECT,
            machine: m5Main,
          })}
          writesElsewhere={false}
          hostReachable
          promptLabel="Message the project coordinator"
          keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
          isPhoneKeyboard={false}
          sendShortcut="enter"
          onAppCommand={null}
          provider={null}
          onSend={async (text) => {
            if (routed) (window.__routed ??= []).push({ ...routed, text });
          }}
          onError={() => {}}
          status={
            <CoordinatorBlockedNotice
              text={workersOnlyProblem(m5Main, false, PROJECT)}
              coordinator={{ key: `${m5Main}:p`, machine: m5Main }}
              projectTitle={PROJECT}
              current="m5:p"
              copies={linked}
              onOpen={() => {}}
              mainOffer={m5Offer}
              onMakeMain={makeMain}
              routesToMain
            />
          }
          notices={null}
          meta={switcherNamed(named.chip)}
          controls={
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate">Opus 5.5</span>
            </span>
          }
          modelFallback={false}
        />
      </div>
    );
  }
  if (view !== "box" && view !== "switched")
    return (
      <div className="fixture-page" data-viewing={current}>
        {switcher}
      </div>
    );
  // The copy's own page: its message box cannot send, and says where main is.
  const onCopy = view === "box" && !viewed.main;
  const environmentId = EnvironmentId.make(current.split(":")[0]!);
  return (
    <div className="fixture-page fixture-column" data-viewing={current}>
      <div className="project-conversation">
        <article className="mb-3 rounded-lg border border-border p-3 text-sm">
          The release notes are drafted. Two threads are still running on {viewed.machine}.
        </article>
      </div>
      <CoordinatorComposer
        composer={getProjectCoordinatorComposer(environmentId, "atlas")}
        threadRef={null}
        environmentId={environmentId}
        cwd="/w/atlas"
        sendBlocked={onCopy}
        missingModel={null}
        canAttach
        uploadsSupported
        maxFileBytes={20 * 1024 * 1024}
        sending={false}
        placeholder={
          onCopy
            ? tx("Work for {project} starts on {machine}.", { project: PROJECT, machine: "m4" })
            : "Ask the coordinator a question or start a task…"
        }
        writesElsewhere={onCopy}
        hostReachable
        promptLabel="Message the project coordinator"
        keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
        isPhoneKeyboard={false}
        sendShortcut="enter"
        onAppCommand={null}
        provider={null}
        onSend={async () => {}}
        onError={() => {}}
        status={
          onCopy ? (
            <CoordinatorBlockedNotice
              text={workersOnlyProblem("m4", params.get("kept") === "1", PROJECT)}
              coordinator={{ key: "m4:p", machine: "m4" }}
              projectTitle={PROJECT}
              hadConversation={params.get("kept") === "1"}
              current={current}
              copies={copies}
              onOpen={setCurrent}
              mainOffer={offers.find((offer) => offer.key === current) ?? null}
              onMakeMain={makeMain}
            />
          ) : view === "switched" ? (
            <OfflineSwitchNotice id="m5:p:fixture-switch" machine="m5" previous="m4" />
          ) : null
        }
        notices={null}
        meta={switcher}
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
            <Page />
          </TooltipProvider>
        </AnchoredToastProvider>
      </ToastProvider>
    ),
  }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
