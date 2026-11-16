/* Synthetic data only: one project on fictional machines, and the two places that switch
   its main. m4 is main; m5 and linux-mini are linked copies (linux-mini kept a
   conversation from before).
   `?view=m5` the page of that copy, `?main=` connected | lost | gone (the old main is
   reachable, lost under 10 minutes ago, or unreachable for longer),
   `?case=` menu | box | switched | unlinked: the machine menu, a copy's message box (the
   real CoordinatorComposer), m5 after an offline switch, and three checkouts of one
   repository that were never linked. `?theme=dark`, `?lang=` the interface language. */
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
import { mainOffer, type MainOffer, type MakeMainPath } from "../../src/studio/makeMain";
import { getProjectCoordinatorComposer } from "../../src/studio/projectCoordinatorComposer";
import type { OrchestratorCopy } from "../../src/studio/projectCoordinatorMachine";
import { workersOnlyProblem } from "../../src/studio/workersOnlyCopy";
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
  }
}

function Page() {
  const tx = useTx();
  const start =
    view === "switched" ? "m5:p" : `${params.get("view") ?? (view === "box" ? "m5" : "m4")}:p`;
  const [current, setCurrent] = useState(start);
  const viewed = copies.find((item) => item.key === current)!;
  const makeMain = (key: string) => (window.__madeMain ??= []).push(key);
  const switcher = (
    <OrchestratorSwitcher
      identity={{ color: "teal" } as never}
      label={viewed.machine}
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
