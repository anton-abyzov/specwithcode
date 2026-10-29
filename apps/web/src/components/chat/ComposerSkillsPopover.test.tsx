// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type ServerProviderSkill } from "@specweave-studio/contracts";

vi.mock("../../studio/projectWorkspace", () => ({ projectWorkspace: { skills: () => ({}) } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    refresh: () => {},
    data: null,
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
    expect(manage.getAttribute("href")).toBe("/settings/skills?skill=html-report");
    // A skill that is on has nothing to manage from here.
    expect(
      document.querySelector("[data-skill-name='deploy'] [data-testid=composer-skill-manage]"),
    ).toBeNull();
  });
});
