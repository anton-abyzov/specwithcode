// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import {
  HandoffWorkspaceSummary,
  destinationDefaultWorktreeStorage,
} from "./HandoffWorkspaceSummary";

it("distinguishes the source worktree from the copied umbrella and destination checkout", () => {
  const html = renderToStaticMarkup(
    <HandoffWorkspaceSummary
      source={{
        projectFolder: "/source/umbrella",
        repository: "/source/umbrella/repos/api",
        checkout: "/external/worktrees/task",
        mode: "worktree",
        branch: "feature/task",
      }}
      copyRoot="/source/umbrella"
      destinationFolder="D:\\Projects\\umbrella"
      destinationCheckout="D:\\Projects\\umbrella"
    />,
  );
  for (const text of [
    "Current checkout",
    "/external/worktrees/task",
    "Worktree",
    "feature/task",
    "Copy root",
    "Destination project folder",
    "External worktrees",
    "live database",
    "destination’s settings",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("D:\\Projects\\worktrees");
});
it("leaves unknown thread and unresolved destination paths explicit", () => {
  const html = renderToStaticMarkup(
    <HandoffWorkspaceSummary source={{ projectFolder: "/source/project" }} />,
  );
  expect(html).toContain("Not reported by the source thread");
  expect(html).toContain("Choose a destination folder");
  expect(html).toContain("Verified when reviewing the handoff");
  expect(html).not.toContain("Copy root");
});
it("shows the registered current checkout without allocating a worktree", () => {
  const html = renderToStaticMarkup(
    <HandoffWorkspaceSummary
      source={{
        projectFolder: "/source/project",
        repository: ".",
        checkout: "/source/project",
        mode: "local",
      }}
      destinationFolder="/target/project"
      destinationCheckout="/target/project"
    />,
  );
  expect(html).toContain("Local · current checkout");
  expect(html).toContain("No new worktree for this transfer");
});

it("uses only a destination-advertised storage default, keeping older servers unknown", () => {
  expect(
    destinationDefaultWorktreeStorage({ defaultWorktreesDirectory: "/target/private/worktrees" }),
  ).toBe("/target/private/worktrees");
  expect(destinationDefaultWorktreeStorage({ worktreesDirectory: "/local/path" })).toBeNull();
  expect(destinationDefaultWorktreeStorage({ defaultWorktreesDirectory: "" })).toBeNull();
  expect(destinationDefaultWorktreeStorage({ defaultWorktreesDirectory: 42 })).toBeNull();
  const html = renderToStaticMarkup(
    <HandoffWorkspaceSummary
      source={{ projectFolder: "/source" }}
      destinationWorktreeStorage="/target/private/worktrees"
    />,
  );
  expect(html).toContain("machine default; project overrides may differ");
});
