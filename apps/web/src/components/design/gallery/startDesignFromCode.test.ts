import type {
  DesignApplyInput,
  DesignCreateInput,
  DesignGetResult,
  DesignSystemSummary,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  designTitleFromBrief,
  reuseOf,
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

/**
 * A fake server: one design, a revision counter, and a thread start that fails
 * `failures` times. `binding` is what the server does with a thread binding:
 * `legacy` ignores one on create (servers before create-time binding), `owner`
 * takes it, `member` refuses it as the guard does for a session without access rights.
 */
function fakeServer(failures: number, binding: "legacy" | "owner" | "member" = "legacy") {
  const calls: string[] = [];
  const applied: DesignApplyInput[] = [];
  const created: DesignCreateInput[] = [];
  const prompts: string[] = [];
  let document = {
    title: "",
    designSystem: null as string | null,
    revision: 0,
    thread: undefined as unknown,
    reuse: undefined as unknown,
  };
  let threads = 0;
  let exists = true;
  const forbidden = {
    ok: false as const,
    message: "Only the owner on this machine can change which thread a design is bound to.",
    code: "forbidden",
  };
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
      calls.push(input.thread === undefined ? "create" : "create+bind");
      created.push(input);
      if (input.thread !== undefined && binding === "member") return forbidden;
      exists = true;
      document = {
        title: input.title,
        designSystem: input.designSystem ?? null,
        revision: 1,
        thread: binding === "owner" ? input.thread : undefined,
        reuse: input.reuse,
      };
      return { ok: true, value: head() };
    },
    apply: async (input) => {
      calls.push(`apply:${input.operations.map((op) => op.op).join(",")}`);
      applied.push(input);
      if (!exists) return { ok: false, message: "No design d_1.", code: "not_found" };
      if (input.expectedRevision !== document.revision)
        return {
          ok: false,
          message: "Revision conflict.",
          code: "conflict",
          currentRevision: document.revision,
        };
      if (binding === "member" && input.operations.some((op) => op.op === "set_thread"))
        return forbidden;
      for (const op of input.operations) {
        if (op.op === "set_title") document.title = op.title;
        if (op.op === "set_design_system") document.designSystem = op.systemId;
        if (op.op === "set_thread") document.thread = op.thread ?? undefined;
        if (op.op === "set_reuse") document.reuse = op.reuse ?? undefined;
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
  /** Someone else edits the design (a rename in the gallery, another device). */
  const editElsewhere = (title: string) => {
    document = { ...document, title, revision: document.revision + 1 };
  };
  const remove = () => {
    exists = false;
  };
  return {
    deps,
    calls,
    applied,
    created,
    prompts,
    document: () => document,
    editElsewhere,
    remove,
  };
}

const input = (pending: PendingDesign | null, brief = "Notifications settings\nWith toggles") => ({
  environmentId,
  project,
  designSystem: null,
  brief,
  systems: [],
  pending,
});

const ecUikit = {
  key: "pkg:repositories/anton-abyzov/ec-uikit",
  name: "ec-uikit",
  description: null,
  paths: ["repositories/anton-abyzov/ec-uikit/src/styles/tokens.css"],
  sources: [
    {
      path: "repositories/anton-abyzov/ec-uikit/src/styles/tokens.css",
      tokens: 283,
      components: 0,
    },
    {
      path: "repositories/anton-abyzov/ec-uikit/src/primitives/index.ts",
      tokens: 0,
      components: 48,
    },
  ],
  tokens: 283,
  components: 321,
  modes: ["light", "dark"],
  swatches: [],
  copies: [],
};

describe("startDesignFromCode", () => {
  it("reuses the design on retry after the thread fails to start: exactly one create", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null));
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.pending?.ref.designId).toBe("d_1");

    const second = await startDesignFromCode(server.deps, input(first.pending));
    expect(second).toMatchObject({ ok: true, ref: { designId: "d_1" } });
    expect(server.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    // Each attempt binds before it starts; the failed one drops its binding.
    expect(server.calls).toEqual([
      "create+bind",
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
    // A sentence-long brief is cut at a word, and the agent is asked for a short title.
    const long =
      "A settings page for notifications where coaches choose which match alerts reach parents";
    expect(designTitleFromBrief(long)).toBe(
      "A settings page for notifications where coaches choose…",
    );
    expect(designTitleFromBrief(`${"word ".repeat(40)}`).length).toBeLessThanOrEqual(60);
    const titled = fakeServer(0);
    await startDesignFromCode(titled.deps, input(null, long));
    expect(titled.prompts[0]).toContain("Give it a short title with set_title.");
  });

  it("creates the design already bound to its thread in one write (AC-01)", async () => {
    const server = fakeServer(0, "owner");
    const result = await startDesignFromCode(server.deps, input(null));
    expect(result).toMatchObject({ ok: true, selfBind: false });
    expect(server.calls).toEqual(["create+bind", "start"]);
    if (result.ok)
      expect(server.document().thread).toEqual({ environmentId, threadId: result.threadId });
    expect(server.prompts[0]).not.toContain("set_thread");
  });

  it("starts the thread when this window may not bind it, and the agent binds itself", async () => {
    const server = fakeServer(0, "member");
    const result = await startDesignFromCode(server.deps, input(null));
    // The refused create wrote nothing; the second create is the only design.
    expect(server.calls).toEqual(["create+bind", "create", "start"]);
    expect(result).toMatchObject({ ok: true, selfBind: true, ref: { designId: "d_1" } });
    if (result.ok)
      expect(server.prompts[0]).toContain(
        `"op":"set_thread","thread":${JSON.stringify({ environmentId, threadId: result.threadId })}`,
      );
  });

  it("never retries a refused binding on the reused design", async () => {
    const server = fakeServer(1, "member");
    const first = await startDesignFromCode(server.deps, input(null, "First idea"));
    if (first.ok) throw new Error("expected a failure");
    expect(first.pending?.ref.designId).toBe("d_1");
    const second = await startDesignFromCode(server.deps, input(first.pending, "Second idea"));
    expect(second).toMatchObject({ ok: true, selfBind: true });
    // The refusal is remembered: the retry sends the retitle alone, never the bind again.
    expect(server.calls).toEqual(["create+bind", "create", "start", "apply:set_title", "start"]);
    expect(server.document().title).toBe("Second idea");
  });

  it("retries on the head revision when the design changed since the failed attempt", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null));
    if (first.ok) throw new Error("expected a failure");
    server.editElsewhere("Renamed in the gallery");
    const second = await startDesignFromCode(server.deps, input(first.pending));
    expect(second).toMatchObject({ ok: true, ref: { designId: "d_1" } });
    expect(server.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
    // The brief did not change, so the rename stays.
    expect(server.document().title).toBe("Renamed in the gallery");
  });

  it("creates the design again when it was deleted since the failed attempt", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null));
    if (first.ok) throw new Error("expected a failure");
    server.remove();
    const second = await startDesignFromCode(server.deps, input(first.pending));
    expect(second.ok).toBe(true);
    expect(server.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
  });

  it("carries a system found in the repository into the brief and the design (AC-03)", async () => {
    const server = fakeServer(0, "owner");
    const proposed: string[] = [];
    const found = ecUikit;
    await startDesignFromCode(
      {
        ...server.deps,
        propose: async (system) => {
          proposed.push(system.name);
          return { ok: true, value: { id: "prop-1" } };
        },
        now: () => "2026-10-23T23:00:00.000Z",
      },
      { ...input(null), found },
    );
    expect(proposed).toEqual(["ec-uikit"]);
    expect(server.created[0]?.reuse).toEqual({
      name: "ec-uikit",
      paths: [
        "repositories/anton-abyzov/ec-uikit/src/styles/tokens.css",
        "repositories/anton-abyzov/ec-uikit/src/primitives/index.ts",
      ],
      tokens: 283,
      components: 321,
      modes: ["light", "dark"],
      proposalId: "prop-1",
      foundAt: "2026-10-23T23:00:00.000Z",
    });
    const prompt = server.prompts[0]!;
    expect(prompt).toContain(
      "Design system found in this repository (not imported yet): ec-uikit, 283 tokens · 321 components · light, dark.",
    );
    expect(prompt).toContain(
      "- repositories/anton-abyzov/ec-uikit/src/primitives/index.ts: 48 components",
    );
    expect(prompt).toContain("proposal prop-1");
    expect(prompt).not.toContain("No design system is set");
  });

  it("keeps the found system's proposal across retries", async () => {
    const server = fakeServer(1, "owner");
    let proposals = 0;
    const deps = {
      ...server.deps,
      propose: async () => ({ ok: true as const, value: { id: `prop-${++proposals}` } }),
    };
    const first = await startDesignFromCode(deps, { ...input(null), found: ecUikit });
    if (first.ok) throw new Error("expected a failure");
    await startDesignFromCode(deps, { ...input(first.pending), found: ecUikit });
    expect(proposals).toBe(1);
    expect(server.document().reuse).toMatchObject({ proposalId: "prop-1" });
  });

  it("follows the found system the latest attempt recorded", async () => {
    const server = fakeServer(2, "owner");
    let proposals = 0;
    const deps = {
      ...server.deps,
      propose: async () => ({ ok: true as const, value: { id: `prop-${++proposals}` } }),
    };
    const other = { ...ecUikit, key: "pkg:other", name: "other-kit" };
    const first = await startDesignFromCode(deps, { ...input(null), found: ecUikit });
    if (first.ok) throw new Error("expected a failure");
    const second = await startDesignFromCode(deps, { ...input(first.pending), found: other });
    if (second.ok) throw new Error("expected a failure");
    expect(second.pending?.foundKey).toBe("pkg:other");
    await startDesignFromCode(deps, { ...input(second.pending), found: other });
    expect(proposals).toBe(2);
  });

  it("records every file the found system reads, strongest first, up to 24", () => {
    const paths = Array.from({ length: 30 }, (_, index) => `src/tokens/${index}.css`);
    const sources = paths
      .slice(0, 12)
      .toReversed()
      .map((path) => ({ path, tokens: 1, components: 0 }));
    const reuse = reuseOf({ ...ecUikit, paths, sources }, null, "2026-10-24T00:00:00.000Z");
    expect(reuse.paths).toHaveLength(24);
    expect(reuse.paths.slice(0, 12)).toEqual(sources.map((source) => source.path));
    expect(reuse.paths[12]).toBe("src/tokens/12.css");
  });

  it("retitles the reused design when the brief changes", async () => {
    const server = fakeServer(1);
    const first = await startDesignFromCode(server.deps, input(null, "First idea"));
    if (first.ok) throw new Error("expected a failure");
    await startDesignFromCode(server.deps, input(first.pending, "Second idea"));
    expect(server.document().title).toBe("Second idea");
    expect(server.calls.filter((call) => call.startsWith("create"))).toHaveLength(1);
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
    expect(server.calls.filter((call) => call.startsWith("create"))).toHaveLength(2);
  });
});
