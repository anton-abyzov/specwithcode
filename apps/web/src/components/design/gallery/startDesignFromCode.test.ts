import type {
  DesignApplyInput,
  DesignGetResult,
  DesignSystemSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  designTitleFromBrief,
  startDesignFromCode,
  type DesignFromCodeDeps,
  type PendingDesign,
} from "./startDesignFromCode";

const environmentId = "host" as EnvironmentId;
const project = { id: "web" as ProjectId, title: "Web app" };

const system = (projectId: string, name: string) =>
  ({
    ref: {
      owner: { kind: "project", environmentId: "host", projectId },
      systemId: "shared-id",
      path: ".specweave/design/systems/shared-id",
    },
    name,
  }) as unknown as DesignSystemSummary;

/** A fake server: one design, a revision counter, and a thread start that fails `failures` times. */
function fakeServer(failures: number) {
  const calls: string[] = [];
  const applied: DesignApplyInput[] = [];
  const prompts: string[] = [];
  let document = { title: "", designSystem: null as string | null, revision: 0 };
  let threads = 0;
  const head = () =>
    ({
      ref: {
        owner: { kind: "project", environmentId: "host", projectId: "web" },
        designId: "d_1",
        path: ".specweave/design/d_1",
      },
      document: { ...document },
    }) as unknown as DesignGetResult;
  const deps: DesignFromCodeDeps = {
    create: async (input) => {
      calls.push("create");
      document = { title: input.title, designSystem: input.designSystem ?? null, revision: 1 };
      return { ok: true, value: head() };
    },
    apply: async (input) => {
      calls.push(`apply:${input.operations.map((op) => op.op).join(",")}`);
      applied.push(input);
      if (input.expectedRevision !== document.revision)
        return { ok: false, message: "Revision conflict." };
      for (const op of input.operations) {
        if (op.op === "set_title") document.title = op.title;
        if (op.op === "set_design_system") document.designSystem = op.systemId;
      }
      document.revision += 1;
      return { ok: true, value: head() };
    },
    startThread: async ({ prompt }) => {
      calls.push("start");
      prompts.push(prompt);
      return threads++ < failures
        ? { ok: false, message: "Provider unavailable." }
        : { ok: true, value: null };
    },
    newThreadId: () => `thread-${calls.length}` as ThreadId,
  };
  return { deps, calls, applied, prompts, document: () => document };
}

const input = (pending: PendingDesign | null, brief = "Notifications settings\nWith toggles") => ({
  environmentId,
  project,
  designSystem: null,
  brief,
  systems: [],
  pending,
});

describe("startDesignFromCode", () => {
  it("reuses the design on retry after the thread fails to start: exactly one create", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.pending?.ref.designId).toBe("d_1");

    const second = await startDesignFromCode(server.deps, input(first.pending));
    expect(second).toMatchObject({ ok: true, ref: { designId: "d_1" } });
    expect(server.calls.filter((call) => call === "create")).toHaveLength(1);
    // Each attempt binds before it starts; the failed one drops its binding.
    expect(server.calls).toEqual([
      "create",
      "apply:set_thread",
      "start",
      "apply:set_thread",
      "apply:set_thread",
      "start",
    ]);
    expect(server.applied.map((call) => call.expectedRevision)).toEqual([1, 2, 3]);
    expect(server.applied[1]?.operations).toEqual([{ op: "set_thread", thread: null }]);
    if (second.ok)
      expect(server.applied[2]?.operations).toEqual([
        { op: "set_thread", thread: { environmentId, threadId: second.threadId } },
      ]);
  });

  it("titles the design with the brief's first line", async () => {
    const server = fakeServer(0);
    await startDesignFromCode(server.deps, input(null, "  Pricing page  \nThree plans"));
    expect(server.document().title).toBe("Pricing page");
    expect(designTitleFromBrief("   ")).toBe("Untitled design");
    expect(designTitleFromBrief(`${"word ".repeat(40)}`).length).toBeLessThanOrEqual(120);
  });

  it("retitles the reused design when the brief changes", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null, "First idea"));
    if (first.ok) throw new Error("expected a failure");
    await startDesignFromCode(server.deps, input(first.pending, "Second idea"));
    expect(server.document().title).toBe("Second idea");
    expect(server.calls.filter((call) => call === "create")).toHaveLength(1);
  });

  it("uses only a design system the chosen project owns", async () => {
    const server = fakeServer(0);
    await startDesignFromCode(server.deps, {
      ...input(null),
      designSystem: "shared-id" as never,
      systems: [system("other", "Other project's system")],
    });
    expect(server.prompts[0]).not.toContain("Other project's system");

    const owned = fakeServer(0);
    await startDesignFromCode(owned.deps, {
      ...input(null),
      designSystem: "shared-id" as never,
      systems: [system("other", "Other project's system"), system("web", "Web UI")],
    });
    expect(owned.prompts[0]).toContain("Web UI");
    expect(owned.prompts[0]).not.toContain("Other project's system");
  });

  it("creates a new design when the project changed since the failed attempt", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null));
    if (first.ok) throw new Error("expected a failure");
    await startDesignFromCode(server.deps, {
      ...input({ ...first.pending!, projectId: "api" as ProjectId }),
    });
    expect(server.calls.filter((call) => call === "create")).toHaveLength(2);
  });
});
