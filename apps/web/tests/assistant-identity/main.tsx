// Personal assistant identity and personal data access over fixture data. Query:
//   ?view=sidebar&state=before|after   two assistants, as listed before and after the upgrade
//   ?view=setup&state=before|after     the setup step without and with icon choice
//   ?view=access                       Settings > Google > Other machines
//   ?theme=light|dark
import {
  EnvironmentId,
  type PersonalDataAccessStatus,
  type PersonalDataSetAccessInput,
  type ProjectIconOverride,
} from "@specweave-studio/contracts";
import {
  distinctAssistantIconPlan,
  LEGACY_ASSISTANT_ICON,
} from "@specweave-studio/shared/assistantIcon";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PersonalDataAccessView } from "../../src/components/settings/PersonalDataAccessSection";
import {
  AssistantIconChoice,
  AssistantIconGlyph,
  suggestedAssistantIcon,
  type AssistantLucideIcon,
} from "../../src/components/studio/AssistantIconChoice";
import { ProjectCreationPreview } from "../../src/components/studio/ProjectCreation";
import "./fixture.css";

const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const after = params.get("state") !== "before";
const bell = LEGACY_ASSISTANT_ICON as AssistantLucideIcon;
const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls });

const assistants = [
  {
    id: "p-m1",
    environmentId: "env-m1",
    createdAt: "2026-10-01T00:00:00.000Z",
    title: "PercyM1",
    machine: "m1",
    waiting: 1,
  },
  {
    id: "p-m4",
    environmentId: "env-m4",
    createdAt: "2026-10-20T00:00:00.000Z",
    title: "Percy",
    machine: "m4",
    waiting: 2,
  },
];

function Sidebar() {
  // The same plan the app applies once both machines are connected.
  const plan = after
    ? distinctAssistantIconPlan(assistants.map((assistant) => ({ ...assistant, icon: bell })))
    : [];
  return (
    <div className="sws-sidebar" style={{ width: 280, padding: 8 }} data-fixture="sidebar">
      <ul className="sws-side-list" aria-label="Personal assistant">
        {assistants.map((assistant) => {
          const icon = (plan.find((change) => change.id === assistant.id)?.icon ??
            bell) as AssistantLucideIcon;
          return (
            <li key={assistant.id}>
              <a className="sws-side-row" data-icon={icon.name} data-color={icon.color}>
                <AssistantIconGlyph icon={icon} className="size-[18px]" />
                <span className="sws-side-row-label">{assistant.title}</span>
                <span className="sws-side-row-hint">{assistant.machine}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Setup() {
  const others = [{ icon: bell as ProjectIconOverride, label: "PercyM1 · m1" }];
  const [picked, setPicked] = useState<AssistantLucideIcon | null>(null);
  const icon = picked ?? suggestedAssistantIcon([bell], "env-m4");
  return (
    <div
      className="mx-auto mt-6 w-[min(100%-24px,560px)] rounded-xl border bg-popover shadow-lg"
      data-fixture="setup"
      data-icon={after ? icon.name : bell.name}
      data-color={after ? icon.color : bell.color}
    >
      <div className="border-b px-4 py-3 text-sm text-muted-foreground">Percy</div>
      <ProjectCreationPreview
        kind="personal"
        name=""
        path={null}
        root={null}
        machine="m4"
        icon={after ? icon : null}
      />
      {after ? (
        <AssistantIconChoice
          value={icon}
          onChange={(next) => {
            calls.push(["icon", next.name, next.color]);
            setPicked(next);
          }}
          others={others}
          seed="env-m4"
        />
      ) : null}
      <div className="h-3" />
    </div>
  );
}

const dana = EnvironmentId.make("env-dana");
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const initial: PersonalDataAccessStatus = {
  machines: [
    {
      environmentId: EnvironmentId.make("env-m1"),
      label: "m1",
      ownMachine: true,
      sources: [],
      requested: [],
    },
    {
      environmentId: dana,
      label: "Dana's MacBook",
      ownMachine: false,
      sources: ["calendar"],
      requested: ["gmail"],
    },
    {
      environmentId: EnvironmentId.make("env-build"),
      label: "Build box",
      ownMachine: false,
      sources: [],
      requested: [],
    },
  ],
  log: [
    {
      at: ago(3),
      environmentId: dana,
      label: "Dana's MacBook",
      source: "gmail",
      action: "refused",
      tool: "studio_google_gmail_search",
    },
    {
      at: ago(40),
      environmentId: dana,
      label: "Dana's MacBook",
      source: "calendar",
      action: "used",
      tool: "studio_google_calendar_events",
    },
    {
      at: ago(60 * 26),
      environmentId: dana,
      label: "Dana's MacBook",
      source: "calendar",
      action: "granted",
    },
  ],
};

function Access() {
  const [status, setStatus] = useState(initial);
  const change = (input: PersonalDataSetAccessInput) => {
    calls.push([input.change, input.environmentId, input.source]);
    setStatus((current) => ({
      machines: current.machines.map((machine) =>
        machine.environmentId !== input.environmentId
          ? machine
          : {
              ...machine,
              sources:
                input.change === "allow"
                  ? [...new Set([...machine.sources, input.source])]
                  : input.change === "revoke"
                    ? machine.sources.filter((source) => source !== input.source)
                    : machine.sources,
              requested: machine.requested.filter((source) => source !== input.source),
            },
      ),
      log: [
        {
          at: new Date().toISOString(),
          environmentId: input.environmentId,
          label: current.machines.find((m) => m.environmentId === input.environmentId)!.label,
          source: input.source,
          action:
            input.change === "allow"
              ? "granted"
              : input.change === "revoke"
                ? "revoked"
                : "dismissed",
        },
        ...current.log,
      ],
    }));
  };
  return (
    <div
      className="mx-auto mt-6 w-[min(100%-24px,720px)] rounded-xl border bg-card"
      data-fixture="access"
    >
      <div className="px-3 py-3 text-sm font-medium sm:px-4">Google account</div>
      <PersonalDataAccessView
        status={status}
        canWrite
        busy={false}
        error={null}
        showAllLog={false}
        onShowAllLog={() => {}}
        onChange={change}
      />
    </div>
  );
}

const view = params.get("view");
createRoot(document.getElementById("root")!).render(
  view === "sidebar" ? <Sidebar /> : view === "access" ? <Access /> : <Setup />,
);
