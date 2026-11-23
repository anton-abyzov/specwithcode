import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvironmentId,
  ProjectId,
  type ProjectWorkspaceReadResult,
} from "@specweave-studio/contracts";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: React.ReactNode }) => <a href="#">{children}</a>,
}));

vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: () => "M5",
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      repositories: [],
      found: [],
      problems: [],
      rootIsRepository: false,
      additionalFolders: [],
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(async () => ({ _tag: "Success", value: {} })),
}));

import { ProjectEnvironment } from "./ProjectEnvironment";

describe("ProjectEnvironment", () => {
  it("renders a one-click Clone here action for synced repositories without a local checkout", () => {
    const value: ProjectWorkspaceReadResult["settings"]["environment"] = {
      additionalFolders: [],
      repositories: [
        {
          id: "repo-1",
          url: "https://github.com/anton-abyzov/notes.git",
          localPath: null,
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ProjectEnvironment
        project={
          {
            id: ProjectId.make("project-percy"),
            environmentId: EnvironmentId.make("env-m5"),
            title: "Percy",
            workspaceRoot: "/Users/anton/.specwithcode/personal",
            scripts: [],
          } as any
        }
        projectKey="project-percy"
        kind="personal"
        value={value}
        revision={1}
        dirty={false}
        disabled={false}
        admissionBlocked={false}
        navigationBlocked={false}
        onChange={vi.fn()}
        onPrepared={vi.fn()}
        onDraftChange={vi.fn()}
        onBusyChange={vi.fn()}
        useWorktrees={null}
      />,
    );

    expect(html).toContain("https://github.com/anton-abyzov/notes.git");
    expect(html).toContain("Not cloned on M5");
    expect(html).toContain("Clone here");
  });

  it("does not show Clone here when the repository already has a local checkout path", () => {
    const value: ProjectWorkspaceReadResult["settings"]["environment"] = {
      additionalFolders: [],
      repositories: [
        {
          id: "repo-1",
          url: "https://github.com/anton-abyzov/notes.git",
          localPath: "/Users/anton/Projects/notes",
        },
      ],
    };

    const html = renderToStaticMarkup(
      <ProjectEnvironment
        project={
          {
            id: ProjectId.make("project-percy"),
            environmentId: EnvironmentId.make("env-m5"),
            title: "Percy",
            workspaceRoot: "/Users/anton/.specwithcode/personal",
            scripts: [],
          } as any
        }
        projectKey="project-percy"
        kind="personal"
        value={value}
        revision={1}
        dirty={false}
        disabled={false}
        admissionBlocked={false}
        navigationBlocked={false}
        onChange={vi.fn()}
        onPrepared={vi.fn()}
        onDraftChange={vi.fn()}
        onBusyChange={vi.fn()}
        useWorktrees={null}
      />,
    );

    expect(html).not.toContain("Not cloned on M5");
  });
});
