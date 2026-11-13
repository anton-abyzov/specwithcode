import { RelayedMessage } from "../../src/components/studio/RelayedMessage";
import { MOBILE_CARRY_FORWARD, MOBILE_USER_RESULTS } from "../agent-messages/internalReceipts";
import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChevronDownIcon, ShieldIcon } from "lucide-react";

import { ComposerControl } from "../../src/components/chat/ComposerControl";
import { ThreadMachineComposerChip } from "../../src/components/chat/ThreadMachineComposerChip";
import { ThreadMetaRow } from "../../src/components/chat/ThreadMetaRow";
import { ProjectEnvironmentBadge } from "../../src/components/ProjectEnvironmentBadge";
import {
  modelChipShows,
  type ModelChipFit,
  type ModelChipPart,
} from "../../src/components/chat/modelChipFit";
import { measureRestingComposerControls } from "../../src/components/chat/restingComposerControlsMeasurement";
import { resolveRestingComposerControlsLayout } from "../../src/components/composerFooterLayout";
import { threadMachinePresentation } from "../../src/components/chat/threadMachine";
import "./fixture.css";

// Real chip, meta row, presentation and fit decision; the provider controls are stand-ins.
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const unreachable = params.has("unreachable");
const machine = threadMachinePresentation({
  name: params.get("name") ?? "linuxbox",
  hostLabel: params.get("name") ?? "linuxbox",
  kind: "laptop",
  os: "linux",
  isThisMachine: false,
  phase: unreachable ? "reconnecting" : "connected",
  error: unreachable ? "timed out" : null,
  canOperate: true,
  handoff: "available",
});

function ComposerRow() {
  const ref = useRef<HTMLDivElement>(null);
  const [hiddenCount, setHiddenCount] = useState(0);
  const [fit, setFit] = useState<ModelChipFit>("full");
  useLayoutEffect(() => {
    const controls = ref.current!;
    const measure = () => {
      const measurement = measureRestingComposerControls(controls);
      if (!measurement) return;
      const layout = resolveRestingComposerControlsLayout({
        ...measurement,
        hostWidth: controls.clientWidth,
      });
      setHiddenCount(layout.hiddenCount);
      setFit(layout.pickerFit ?? "full");
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    return () => observer.disconnect();
  }, []);
  // Parts a fit leaves out stay mounted out of flow, as the fit rules in shell.css keep them.
  const part = (name: ModelChipPart, content: string) => (
    <span
      data-model-chip-part={name}
      className={modelChipShows(fit, name) ? "whitespace-nowrap" : "invisible absolute w-max"}
    >
      {content}
    </span>
  );
  const blocks = [
    <ComposerControl key="access">
      <ShieldIcon /> Full access <ChevronDownIcon className="size-3" />
    </ComposerControl>,
    <ComposerControl key="traits">
      Medium 1M · Thinking <ChevronDownIcon className="size-3" />
    </ComposerControl>,
  ];
  return (
    // As ChatComposer's footer: one row while it fits, and below 560px the controls
    // (machine and model first) take a row of their own over the actions.
    <div className="flex items-center gap-2 px-3 pb-3 @max-[560px]/composer-surface:flex-wrap @max-[560px]/composer-surface:gap-y-1">
      <div
        ref={ref}
        data-fixture-controls
        className="relative flex min-w-0 flex-1 items-center gap-1 @max-[560px]/composer-surface:basis-full"
      >
        <ThreadMachineComposerChip machine={machine} size="sm" />
        <ComposerControl data-chat-provider-model-picker="" data-fit={fit} className="shrink-0">
          {part("mark", "✳")}
          {part("provider", "Claude Code")}
          {part("model", "Opus 5.5")}
          {part("usage-value", "8%")}
        </ComposerControl>
        {blocks.map((block, index) => (
          <div
            key={block.key}
            data-resting-block={block.key}
            className={
              index >= blocks.length - hiddenCount
                ? "pointer-events-none invisible absolute flex w-max"
                : "flex w-max shrink-0"
            }
          >
            {block}
          </div>
        ))}
        <div
          data-resting-controls-overflow
          className={hiddenCount === 0 ? "pointer-events-none invisible absolute" : "shrink-0"}
        >
          <ComposerControl>
            <ChevronDownIcon className="size-3" />
          </ComposerControl>
        </div>
      </div>
      <div className="flex w-36 shrink-0 justify-end @max-[560px]/composer-surface:ms-auto">
        <ComposerControl>Skills 118</ComposerControl>
      </div>
    </div>
  );
}

function Fixture() {
  const [scenario, setScenario] = useState("settled");
  const timing = params.has("timing");
  const now = Date.now();
  const iso = (offset: number) => new Date(now + offset * 60000).toISOString();
  const previous = { id: "first", status: "completed", startedAt: iso(-60), completedAt: iso(-55) };
  const latest = {
    id: "latest",
    status:
      scenario === "queued"
        ? "queued"
        : scenario === "missing"
          ? "failed"
          : scenario === "settled" || scenario === "watch"
            ? "completed"
            : "running",
    startedAt: scenario === "queued" ? null : iso(-2),
    completedAt: scenario === "settled" || scenario === "watch" ? iso(-1) : null,
  };

  return (
    <main className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-11 items-center gap-2 px-4 text-sm text-muted-foreground">
        No project <span>/</span> <span className="text-foreground">Current Time</span>
      </header>
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 pt-2">
        {timing && (
          <div className="flex flex-wrap gap-2">
            {["settled", "live", "wait", "queued", "watch", "missing"].map((value) => (
              <button key={value} className="rounded border p-2" onClick={() => setScenario(value)}>
                {value}
              </button>
            ))}
          </div>
        )}
        <ThreadMetaRow
          machine={machine}
          origin={null}
          folder={{
            label: "2026-10-26-time-now-44ce7",
            path: "/home/dev/chats/2026-10-26-time-now-44ce7",
          }}
          run={
            timing
              ? latest
              : { startedAt: "2026-10-26T22:40:00.000Z", completedAt: "2026-10-26T22:40:30.000Z" }
          }
          recordedRuns={timing ? [previous, latest] : undefined}
          historyComplete={timing}
          runHealth={
            scenario === "wait"
              ? { state: "waiting", label: "Waiting for a tool", idleMs: 0, waitingMs: 0 }
              : null
          }
          background={
            scenario === "watch"
              ? { label: "Watching pull request checks", waiting: true, kind: "monitor" }
              : null
          }
          pullRequests={[]}
          onOpenPullRequest={() => {}}
        />
        {params.has("mobile") && (
          <section>
            {(["coordinator", "thread"] as const).map((source) => (
              <RelayedMessage
                key={source}
                detail="concise"
                source={source}
                label={`Message from ${source}`}
                view={{ label: "View source", onOpen: () => {} }}
                createdAt="2026-10-28T16:45:40Z"
                timestampFormat="12-hour"
                original={MOBILE_CARRY_FORWARD}
                text={MOBILE_CARRY_FORWARD}
                renderMarkdown={(text) => <p>{text}</p>}
              />
            ))}
            {MOBILE_USER_RESULTS.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </section>
        )}
        <div className="self-end rounded-2xl bg-secondary px-3 py-2 text-sm">
          What is the name of the machine you are running on?
        </div>
        <div className="text-sm">
          The machine's hostname is <code>linuxbox</code>.
        </div>
        <div className="flex-1" />
        <div className="@container/composer-surface mb-4 rounded-2xl border bg-card">
          <div className="px-4 pt-3 pb-8 text-sm text-muted-foreground">
            Ask anything, @tag files/folders, $use skills, or / for commands
          </div>
          <ComposerRow />
        </div>
      </div>
    </main>
  );
}
// `?projects`: the project picker's rows, where a project on other machines names them.
const member = (environmentId: string, environmentLabel: string | null) =>
  ({ environmentId, environmentLabel }) as never;
function ProjectRows() {
  const rows = [
    { name: "specweave", members: [member("here", null), member("m4", "M4")] },
    { name: "easychamp", members: [member("m1", "m1"), member("minis", "Minis")] },
    { name: "sketchmate", members: [member("office", "Office Mac Studio")] },
  ];
  return (
    <main className="flex min-h-screen flex-col gap-1 bg-background p-3 text-foreground">
      {rows.map((row) => (
        <div
          key={row.name}
          className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent"
          data-project-row=""
        >
          <span className="min-w-0 truncate">{row.name}</span>
          <ProjectEnvironmentBadge
            group={{ memberProjects: row.members }}
            primaryEnvironmentId={"here" as never}
            machineByEnvironmentId={new Map()}
          />
        </div>
      ))}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  params.has("projects") ? <ProjectRows /> : <Fixture />,
);
