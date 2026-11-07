// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ServerProviderSkill,
} from "@specweave-studio/contracts";

const queryState = vi.hoisted(() => ({ snapshot: null as any }));

vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    {
      projectKey: "logical-project",
      memberProjects: [
        { id: "project", environmentId: "host", physicalProjectKey: "host:/work/app" },
      ],
    },
  ],
}));

vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skills: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: () => {},
    data: queryState.snapshot,
    dataUpdatedAt: 0,
    error: null,
    failure: null,
    isPending: false,
  }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => async () => ({}) }));
vi.mock("@tanstack/react-router", () => ({
  Link: (props: {
    to: string;
    search?: Record<string, string>;
    children: unknown;
    className?: string;
    "aria-label"?: string;
    "data-testid"?: string;
  }) => (
    <a
      href={`${props.to}${props.search ? `?${new URLSearchParams(props.search).toString()}` : ""}`}
      className={props.className}
      aria-label={props["aria-label"]}
      data-testid={props["data-testid"]}
    >
      {props.children as never}
    </a>
  ),
}));

import { ComposerSkillsPopover } from "./ComposerSkillsPopover";

const skills: ReadonlyArray<ServerProviderSkill> = [
  {
    name: "deploy",
    path: "/work/app/.claude/skills/deploy/SKILL.md",
    scope: "project",
    enabled: true,
  },
  {
    name: "html-report",
    path: "/home/me/.claude/skills/html-report/SKILL.md",
    scope: "user",
    enabled: false,
  },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  queryState.snapshot = null;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ComposerSkillsPopover", () => {
  it("greys a switched-off skill and links it to its Skills settings", async () => {
    await act(async () =>
      root.render(
        <ComposerSkillsPopover
          environmentId={EnvironmentId.make("host")}
          projectId={ProjectId.make("project")}
          cwd="/work/app"
          provider={undefined}
          machineLabel="M4"
          skills={skills}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=composer-skills-trigger]")!.click(),
    );
    const off = document.querySelector<HTMLElement>("[data-skill-name='html-report']")!;
    expect(off.getAttribute("data-skill-enabled")).toBe("false");
    // The name greys out; the Manage link sits outside it at full contrast, with a focus ring.
    expect(off.className).not.toContain("opacity-50");
    expect(
      off.querySelector<HTMLElement>("[data-testid=composer-skill-label]")!.className,
    ).toContain("opacity-50");
    const manage = off.querySelector<HTMLAnchorElement>("[data-testid=composer-skill-manage]")!;
    expect(manage.textContent).toBe("Manage");
    expect(manage.closest(".opacity-50")).toBeNull();
    expect(manage.className).toContain("focus-visible:ring-2");
    expect(manage.getAttribute("href")).toBe(
      "/settings/skills?machine=host&skillContext=host%3Aproject&project=logical-project&checkout=host%3A%2Fwork%2Fapp&skill=html-report",
    );
    // Every enabled skill opens the scoped detail page too.
    expect(document.querySelector<HTMLAnchorElement>("[data-skill-name=deploy] a")?.href).toContain(
      "skill=deploy",
    );
    expect(
      document.querySelector("[data-skill-name='deploy'] [data-testid=composer-skill-manage]"),
    ).toBeNull();
  });
  it("updates matches per keystroke and labels totals and disabled skills", async () => {
    const list = Array.from({ length: 20 }, (_, i) => ({
      name: `skill-${i === 19 ? 0 : i}`,
      path: `/skills/${i}/SKILL.md`,
      enabled: i < 13,
      scope: i === 18 ? "system" : "user",
      shortDescription: "Short summary",
      description: i === 3 ? "Marketing football campaigns" : "Other work",
    }));
    await act(async () =>
      root.render(
        <ComposerSkillsPopover
          environmentId={EnvironmentId.make("host")}
          projectId={ProjectId.make("project")}
          cwd="/work/app"
          provider={
            { instanceId: "codex", displayName: "Codex", snapshot: { status: "ready" } } as never
          }
          machineLabel="M3"
          skills={list}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      "[data-testid=composer-skills-trigger]",
    )!;
    expect(trigger.textContent).toContain("19");
    await act(async () => trigger.click());
    const panel = document.querySelector<HTMLElement>("[data-testid=composer-skills-popover]")!;
    expect(panel.textContent).toContain("19 skills · 13 enabled · 6 off");
    expect(panel.querySelector('[aria-label="System"]')).not.toBeNull();
    const input = panel.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const text of ["ma", "mar", "marketing", "marketing football", "nomatch", ""]) {
      await act(async () => {
        setter.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const expected =
        text === "" ? 19 : text === "nomatch" ? 0 : ["ma", "mar"].includes(text) ? 19 : 1;
      expect(panel.querySelectorAll("[data-skill-name]")).toHaveLength(expected);
      if (text) expect(panel.textContent).toContain(`${expected} of 19 skills`);
    }
    await act(async () => {
      setter.call(input, "marketing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => trigger.click());
    await act(async () => trigger.click());
    expect(
      document.querySelector<HTMLInputElement>('input[aria-label="Search skills"]')?.value,
    ).toBe("marketing");
    const settings = [...panel.querySelectorAll("a")].find(
      (a) => a.textContent === "Open Skills settings",
    )!;
    expect(settings.getAttribute("href")).toContain("agent=codex");
    expect(settings.getAttribute("href")).toContain("machine=host");
    expect(settings.getAttribute("href")).toContain("project=logical-project");
  });
  it("deep links differing copies with exact machine, agent and thread folder", async () => {
    queryState.snapshot = {
      rows: [
        {
          name: "deploy",
          status: "ok",
          attention: false,
          issues: [],
          doctor: [],
          drift: "unlocked",
          copies: 2,
          divergent: true,
          lock: null,
          providers: [
            {
              instanceId: "codex",
              driver: "codex",
              label: "Codex",
              path: skills[0]!.path,
              scope: "project",
              enabled: true,
              fileVersion: "1.0.0",
            },
          ],
        },
      ],
      providers: [],
    };
    await act(async () =>
      root.render(
        <ComposerSkillsPopover
          environmentId={EnvironmentId.make("host")}
          projectId={ProjectId.make("project")}
          cwd="/work/app"
          threadId={ThreadId.make("thread-a")}
          provider={
            { instanceId: "codex", displayName: "Codex", snapshot: { status: "ready" } } as never
          }
          machineLabel="Laptop"
          skills={skills}
        />,
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid=composer-skills-trigger]")!.click(),
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '[aria-label="Compare copies of deploy"]',
    )!;
    expect(link).not.toBeNull();
    const params = new URL(link.href).searchParams;
    expect(Object.fromEntries(params)).toMatchObject({
      machine: "host",
      project: "logical-project",
      agent: "codex",
      skill: "deploy",
      skillView: "compare",
      skillThread: "thread-a",
      skillCwd: "/work/app",
      skillContext: "host:project",
    });
  });
});
