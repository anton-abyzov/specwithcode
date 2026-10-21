// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { specweaveStudioCheckpointPath } from "../orchestration-v2/SpecweaveCheckpoint.ts";
import {
  criteriaWithState,
  listProjectIncrements,
  readThreadIncrementProgress,
  specweaveStudioThreadBindingPath,
} from "./ThreadIncrementProgress.ts";

const roots: string[] = [];
const NOW = Date.parse("2026-10-15T12:00:00Z");

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const SPEC = `# Studio plan card

## Acceptance criteria
- [ ] AC-01: The card shows done, current and next
- [ ] AC-02: Lists show 3/5
- [ ] AC-03: Nobody cites this one

## Tasks
### T-01 Contract
**AC**: AC-01
### T-02 Reader
**AC**: AC-01, AC-02
### T-03 Card
**AC**: AC-02
### T-04 Docs
`;

function line(event: Record<string, string>): string {
  return `${JSON.stringify(event)}\n`;
}

async function increment(root: string, id: string, ledger: string) {
  const folder = NodePath.join(root, ".specweave/increments", id);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(folder, "spec.md"), SPEC);
  await NodeFSP.writeFile(NodePath.join(folder, "ledger.jsonl"), ledger);
  await NodeFSP.writeFile(
    NodePath.join(folder, "metadata.json"),
    JSON.stringify({ status: "active", title: "Plan card" }),
  );
  return folder;
}

const LEDGER = [
  line({ t: "T-01", e: "claim", by: "claude@m4", at: "2026-10-15T10:00:00Z" }),
  line({ t: "T-01", e: "done", by: "claude@m4", at: "2026-10-15T10:30:00Z", evidence: "abc123" }),
  // Done without evidence does not count.
  line({ t: "T-02", e: "done", by: "claude@m4", at: "2026-10-15T10:40:00Z" }),
  line({ t: "T-02", e: "claim", by: "claude@m4", at: "2026-10-15T11:30:00Z" }),
  line({ t: "T-04", e: "skip", by: "claude@m4", at: "2026-10-15T11:00:00Z", note: "Out of scope" }),
].join("");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

describe("readThreadIncrementProgress", () => {
  it("binds a thread by the increment number in its branch and folds the ledger", async () => {
    const root = await temp("studio-plan-root-");
    const home = await temp("studio-plan-home-");
    await increment(root, "0930-studio-plan-card", LEDGER);
    await increment(root, "0931-other", "");
    const [progress, ...rest] = await readThreadIncrementProgress(
      root,
      [
        {
          threadId: "t1",
          title: "Plan card",
          branch: "feat/0930-plan-card",
          worktreePath: null,
          home,
        },
        { threadId: "t2", title: "Unrelated", branch: "main", worktreePath: null, home },
      ],
      NOW,
    );
    expect(rest).toEqual([]);
    expect(progress).toMatchObject({
      threadId: "t1",
      incrementId: "0930-studio-plan-card",
      binding: "name",
      boundTaskId: null,
      title: "Plan card",
      status: "active",
      readable: true,
    });
    expect(progress!.specPath).toBe(
      NodePath.join(root, ".specweave/increments/0930-studio-plan-card/spec.md"),
    );
    expect(progress!.tasks.map((task) => [task.id, task.status])).toEqual([
      ["T-01", "done"],
      ["T-02", "claimed"],
      ["T-03", "planned"],
      ["T-04", "skipped"],
    ]);
    expect(progress!.tasks.find((task) => task.id === "T-04")!.note).toBe("Out of scope");
    expect(progress!.criteria).toEqual([
      {
        id: "AC-01",
        text: "The card shows done, current and next",
        met: false,
        state: "open",
        tasks: ["T-01", "T-02"],
      },
      { id: "AC-02", text: "Lists show 3/5", met: false, state: "open", tasks: ["T-02", "T-03"] },
      { id: "AC-03", text: "Nobody cites this one", met: false, state: "uncovered", tasks: [] },
    ]);
    // A done task carries the time the ledger accepted it, the anchor for "verified".
    expect(progress!.tasks.find((task) => task.id === "T-01")!.doneAt).toMatch(/^2026-/u);
  });

  it("prefers SpecWeave's checkpoint pointer and reads the thread's worktree ledger", async () => {
    const root = await temp("studio-plan-root-");
    const worktree = await temp("studio-plan-worktree-");
    const home = await temp("studio-plan-home-");
    await increment(root, "0930-studio-plan-card", "");
    await increment(
      worktree,
      "0930-studio-plan-card",
      line({ t: "T-03", e: "done", by: "codex@m4", at: "2026-10-15T11:00:00Z", evidence: "x" }),
    );
    const pointer = specweaveStudioCheckpointPath("t1", home);
    await NodeFSP.mkdir(NodePath.dirname(pointer), { recursive: true });
    await NodeFSP.writeFile(pointer, JSON.stringify({ incrementId: "0930-studio-plan-card" }));
    const [progress] = await readThreadIncrementProgress(
      root,
      // Title and branch name nothing; only the pointer binds the thread.
      [{ threadId: "t1", title: "Untitled", branch: null, worktreePath: worktree, home }],
      NOW,
    );
    expect(progress!.incrementPath).toBe(
      NodePath.join(worktree, ".specweave/increments/0930-studio-plan-card"),
    );
    expect(progress!.binding).toBe("checkpoint");
    expect(progress!.tasks.find((task) => task.id === "T-03")!.status).toBe("done");
  });

  it("prefers the increment the thread wrote to, and refuses a binding outside its checkout", async () => {
    const root = await temp("studio-plan-root-");
    const elsewhere = await temp("studio-plan-elsewhere-");
    const home = await temp("studio-plan-home-");
    await increment(root, "0930-studio-plan-card", LEDGER);
    await increment(root, "0931-other", "");
    await increment(elsewhere, "0932-foreign", "");
    const bind = async (bindingRoot: string, incrementId: string) => {
      const file = specweaveStudioThreadBindingPath("t1", home);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(
        file,
        JSON.stringify({
          version: 1,
          threadId: "t1",
          incrementId,
          root: bindingRoot,
          taskId: "T-02",
          event: "claim",
          at: "2026-10-15T11:30:00Z",
        }),
      );
    };
    // The branch names 0931, but the agent claimed in 0930: the claim wins.
    await bind(root, "0930-studio-plan-card");
    const source = {
      threadId: "t1",
      title: "x",
      branch: "feat/0931-other",
      worktreePath: null,
      home,
    };
    const [claimed] = await readThreadIncrementProgress(root, [source], NOW);
    expect(claimed).toMatchObject({
      incrementId: "0930-studio-plan-card",
      binding: "claim",
      boundTaskId: "T-02",
    });
    // A binding into another checkout is ignored; the branch decides instead.
    await bind(elsewhere, "0932-foreign");
    const [fallback] = await readThreadIncrementProgress(root, [source], NOW);
    expect(fallback).toMatchObject({ incrementId: "0931-other", binding: "name" });
  });

  it("puts a link made by hand above every other binding, and hides the increment for none", async () => {
    const root = await temp("studio-plan-root-");
    const home = await temp("studio-plan-home-");
    await increment(root, "0930-studio-plan-card", LEDGER);
    await increment(root, "0931-other", "");
    const file = specweaveStudioThreadBindingPath("t1", home);
    await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
    await NodeFSP.writeFile(
      file,
      JSON.stringify({
        version: 1,
        threadId: "t1",
        incrementId: "0930-studio-plan-card",
        root,
        taskId: "T-02",
        event: "claim",
        at: "2026-10-15T11:30:00Z",
      }),
    );
    const source = {
      threadId: "t1",
      title: "x",
      branch: "feat/0930-plan",
      worktreePath: null,
      home,
    };
    const [other] = await readThreadIncrementProgress(
      root,
      [{ ...source, link: { incrementId: "0931-other" } }],
      NOW,
    );
    // The claim names another increment, so its task is not this thread's here.
    expect(other).toMatchObject({
      incrementId: "0931-other",
      binding: "manual",
      boundTaskId: null,
    });
    const [same] = await readThreadIncrementProgress(
      root,
      [{ ...source, link: { incrementId: "0930-studio-plan-card" } }],
      NOW,
    );
    expect(same).toMatchObject({ binding: "manual", boundTaskId: "T-02" });
    expect(
      await readThreadIncrementProgress(root, [{ ...source, link: { incrementId: null } }], NOW),
    ).toEqual([]);
  });

  it("lists the checkout's increments newest first", async () => {
    const root = await temp("studio-plan-root-");
    await increment(root, "0930-studio-plan-card", "");
    await increment(root, "1002-later", "");
    await NodeFSP.mkdir(NodePath.join(root, ".specweave/increments/_archive"), { recursive: true });
    expect(await listProjectIncrements(root, null)).toEqual([
      { incrementId: "1002-later", title: "Plan card", status: "active" },
      { incrementId: "0930-studio-plan-card", title: "Plan card", status: "active" },
    ]);
  });

  it("reads a member repository's increments from the umbrella workspace above it", async () => {
    const umbrella = await temp("studio-plan-umbrella-");
    const home = await temp("studio-plan-home-");
    await NodeFSP.mkdir(NodePath.join(umbrella, ".specweave"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(umbrella, ".specweave/config.json"), "{}");
    await increment(umbrella, "0930-studio-plan-card", LEDGER);
    await increment(umbrella, "0931-other", "");
    const member = NodePath.join(umbrella, "repositories/owner/member");
    const sibling = NodePath.join(umbrella, "repositories/owner/sibling");
    await NodeFSP.mkdir(member, { recursive: true });
    await increment(sibling, "0940-sibling", "");
    const bind = async (bindingRoot: string, incrementId: string) => {
      const file = specweaveStudioThreadBindingPath("t1", home);
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(
        file,
        JSON.stringify({
          version: 1,
          threadId: "t1",
          incrementId,
          root: bindingRoot,
          taskId: "T-02",
          event: "claim",
          at: "2026-10-15T11:30:00Z",
        }),
      );
    };
    const source = { threadId: "t1", title: "x", branch: null, worktreePath: null, home };
    // The CLI run in the member repo wrote to the umbrella's ledger: the claim binds.
    await bind(umbrella, "0930-studio-plan-card");
    const [claimed] = await readThreadIncrementProgress(member, [source], NOW);
    expect(claimed).toMatchObject({
      incrementId: "0930-studio-plan-card",
      binding: "claim",
      boundTaskId: "T-02",
      tasks: expect.arrayContaining([expect.objectContaining({ id: "T-01", status: "done" })]),
    });
    // A sibling repository under the same umbrella is not this checkout's planning root.
    await bind(sibling, "0940-sibling");
    expect(await readThreadIncrementProgress(member, [source], NOW)).toEqual([]);
    // A worktree outside the umbrella still finds it through the project folder.
    const worktree = await temp("studio-plan-worktree-");
    const [byBranch] = await readThreadIncrementProgress(
      member,
      [{ ...source, branch: "inc/0931-other", worktreePath: worktree }],
      NOW,
    );
    expect(byBranch).toMatchObject({ incrementId: "0931-other", binding: "branch" });
    // The Link picker lists the umbrella's increments.
    expect(
      (await listProjectIncrements(member, worktree)).map((entry) => entry.incrementId),
    ).toEqual(["0931-other", "0930-studio-plan-card"]);
  });

  it("skips an ancestor .specweave without a config and stops at the nearest config", async () => {
    const umbrella = await temp("studio-plan-umbrella-");
    await increment(umbrella, "0930-studio-plan-card", "");
    await NodeFSP.writeFile(NodePath.join(umbrella, ".specweave/config.json"), "{}");
    const parent = NodePath.join(umbrella, "parent");
    await increment(parent, "0940-stray", "");
    const member = NodePath.join(parent, "member");
    await NodeFSP.mkdir(member, { recursive: true });
    expect((await listProjectIncrements(member, null)).map((entry) => entry.incrementId)).toEqual([
      "0930-studio-plan-card",
    ]);
    // A project with its own config but no increments yet does not borrow the umbrella's.
    await NodeFSP.mkdir(NodePath.join(member, ".specweave"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(member, ".specweave/config.json"), "{}");
    expect(await listProjectIncrements(member, null)).toEqual([]);
  });

  it("reports an unreadable ledger instead of folding it as nothing done", async () => {
    const root = await temp("studio-plan-root-");
    const home = await temp("studio-plan-home-");
    const folder = await increment(root, "0930-studio-plan-card", "");
    await NodeFSP.rm(NodePath.join(folder, "ledger.jsonl"));
    await NodeFSP.mkdir(NodePath.join(folder, "ledger.jsonl"));
    const [progress] = await readThreadIncrementProgress(
      root,
      [{ threadId: "t1", title: "0930", branch: null, worktreePath: null, home }],
      NOW,
    );
    expect(progress).toMatchObject({ readable: false, tasks: [] });
  });
});

describe("criteriaWithState", () => {
  it("meets a criterion only when every citing task is finished", () => {
    expect(
      criteriaWithState(
        [
          { id: "AC-01", text: "a" },
          { id: "AC-02", text: "b" },
        ],
        [
          { status: "done", criteria: ["AC-01", "AC-02"] },
          { status: "skipped", criteria: ["AC-01"] },
          { status: "claimed", criteria: ["AC-02"] },
        ],
      ).map((criterion) => criterion.met),
    ).toEqual([true, false]);
  });
});

describe("criteriaWithState traceability", () => {
  const criteria = [
    { id: "AC-01", text: "evidenced and verified", story: "US-001" },
    { id: "AC-02", text: "shared by two tasks" },
    { id: "AC-03", text: "no task", checked: true },
    { id: "AC-04", text: "no task, no tick" },
    { id: "AC-05", text: "skipped" },
    { id: "AC-06", text: "legacy done" },
  ];
  const tasks = [
    { id: "T-01", status: "done", criteria: ["AC-01", "AC-02"], doneAt: "2026-10-20T10:00:00Z" },
    { id: "T-02", status: "claimed", criteria: ["AC-02"] },
    { id: "T-03", status: "skipped", criteria: ["AC-05"] },
    { id: "T-04", status: "done", criteria: ["AC-06"] },
  ];
  const states = (verify: { ok: boolean; ranAt: string } | null) =>
    criteriaWithState(criteria, tasks, { verify }).map((criterion) => [
      criterion.id,
      criterion.state,
    ]);

  it("separates verified, evidenced, declared, skipped, open and uncovered", () => {
    expect(states({ ok: true, ranAt: "2026-10-20T11:00:00Z" })).toEqual([
      ["AC-01", "verified"],
      ["AC-02", "open"],
      ["AC-03", "declared"],
      ["AC-04", "uncovered"],
      ["AC-05", "skipped"],
      ["AC-06", "declared"],
    ]);
  });

  it("never reads a verify run older than the evidence, or a failed one, as verified", () => {
    expect(states({ ok: true, ranAt: "2026-10-20T09:00:00Z" })[0]).toEqual(["AC-01", "evidenced"]);
    expect(states({ ok: false, ranAt: "2026-10-20T11:00:00Z" })[0]).toEqual(["AC-01", "evidenced"]);
    expect(states(null)[0]).toEqual(["AC-01", "evidenced"]);
  });

  it("does not read a criterion as verified when one of its tasks was skipped", () => {
    const [criterion] = criteriaWithState(
      [{ id: "AC-01", text: "half skipped" }],
      [
        { id: "T-01", status: "done", criteria: ["AC-01"], doneAt: "2026-10-20T10:00:00Z" },
        { id: "T-02", status: "skipped", criteria: ["AC-01"] },
      ],
      { verify: { ok: true, ranAt: "2026-10-20T11:00:00Z" } },
    );
    expect(criterion?.state).toBe("evidenced");
  });

  it("lists every covering task, many-to-many, and the story", () => {
    const traced = criteriaWithState(criteria, tasks);
    expect(traced[0]).toMatchObject({ tasks: ["T-01"], story: "US-001", met: true });
    expect(traced[1]).toMatchObject({ tasks: ["T-01", "T-02"], met: false });
    expect(traced[3]).toMatchObject({ tasks: [], met: false });
  });

  it("says unknown, not uncovered, when the ledger cannot be read", () => {
    expect(
      criteriaWithState(criteria.slice(2, 4), [], { readable: false }).map((c) => c.state),
    ).toEqual(["declared", "unknown"]);
  });
});
