// @effect-diagnostics nodeBuiltinImport:off -- The fixture project folder is laid out with node:fs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectLibraryError,
  ProviderInstanceId,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as OfficeArtifactService from "../../../project/OfficeArtifactService.ts";
import {
  readSheetArtifact,
  resolveSheetLockDbPath,
  resolveSheetLockIdentity,
  writeSheetArtifact,
  writeSheetFileCompareAndSet,
} from "../../../project/OfficeArtifacts.ts";
import { ProjectLibraryProblem } from "../../../project/ProjectLibrary.ts";
import * as Context from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { OfficeToolkit } from "./tools.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "office-mcp-"));
const outside = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "office-mcp-outside-"));
afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.rmSync(outside, { recursive: true, force: true });
});
NodeFS.mkdirSync(NodePath.join(root, ".specweave"), { recursive: true });

const caller = liveThreadShell(ThreadId.make("office-worker"));
const scopeFor = (provider: string): Context.McpInvocationScope => ({
  environmentId: EnvironmentId.make("fixture"),
  requestNamespace: "fixture",
  thread: {
    threadId: caller.id,
    providerSessionId: "fixture",
    providerInstanceId: ProviderInstanceId.make(provider),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration" as const]),
});
const scope = scopeFor("codex");

const problem = (projectId: ProjectLibraryError["projectId"]) => (error: unknown) =>
  new ProjectLibraryError({
    projectId,
    code: error instanceof ProjectLibraryProblem ? error.code : "operation_failed",
    detail: error instanceof Error ? error.message : "failed",
  });

/** The real file reader and writer behind the service, over a fixture project. */
const sheetsIn = (folder: string) =>
  Layer.mock(OfficeArtifactService.OfficeArtifactService)({
    writeSheet: (input) =>
      Effect.tryPromise({
        try: () =>
          writeSheetArtifact(folder, input.sheet, {
            name: input.name,
            merge: input.merge,
            expectedRevision: input.expectedRevision,
          }),
        catch: problem(input.projectId),
      }),
    readSheet: (input) =>
      Effect.tryPromise({
        try: () => readSheetArtifact(folder, input.name),
        catch: problem(input.projectId),
      }),
  });

const layerFor = (
  invocation: Context.McpInvocationScope,
  shell: ReturnType<typeof liveThreadShell> = caller,
  folder: string = root,
) =>
  Access.HandlersLayer.layer(Handlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sheetsIn(folder),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(shell),
        }),
        Layer.succeed(Context.McpInvocationContext, invocation),
      ),
    ),
  );

const call = (tool: "sheet_write" | "sheet_read", input: Record<string, unknown>) =>
  Effect.gen(function* () {
    const toolkit = yield* OfficeToolkit;
    return yield* toolkit.handle(tool, input as never).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result as Record<string, unknown>),
    );
  });

const BUDGET = {
  title: "Q3 Budget",
  tabs: [
    {
      name: "Plan",
      cells: {
        A1: "Line",
        B1: "Amount",
        A2: "Rent",
        B2: 2150,
        A3: "Food",
        B3: 1024.51,
        A4: "Total",
        B4: "=SUM(B2:B3)",
        A5: "Rent share",
        B5: "=B2/B4",
      },
      formats: {
        "B2:B4": { kind: "currency", currency: "USD" },
        B5: { kind: "percent", decimals: 1 },
      },
      charts: [
        {
          type: "donut",
          title: "Rent is two thirds of spending",
          labels: "A2:A3",
          values: "B2:B3",
        },
      ],
    },
  ],
};

it.effect("writes a sheet into the project's artifacts folder and reads its computed values", () =>
  Effect.gen(function* () {
    const saved = yield* call("sheet_write", BUDGET);
    const path = NodePath.join(root, ".specweave/artifacts/q3-budget.sheet.json");
    expect(saved).toMatchObject({
      name: "q3-budget",
      path,
      relativePath: ".specweave/artifacts/q3-budget.sheet.json",
      title: "Q3 Budget",
      link: `[Q3 Budget](${path})`,
      created: true,
      tabs: ["Plan"],
      cells: 10,
      formulas: 2,
      charts: 1,
      errors: [],
    });
    const stored = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    expect(stored).toMatchObject({ v: 1, kind: "sheet", title: "Q3 Budget" });
    expect(NodeFS.readdirSync(NodePath.dirname(path))).toEqual(["q3-budget.sheet.json"]);

    const read = yield* call("sheet_read", { name: "q3-budget" });
    expect(read).toMatchObject({
      title: "Q3 Budget",
      tab: "Plan",
      range: "A1:B5",
      truncated: false,
      notice: Handlers.SHEET_READ_NOTICE,
    });
    const cells = read.cells as Array<Record<string, unknown>>;
    expect(cells.find((cell) => cell.cell === "B4")).toEqual({
      cell: "B4",
      value: 3174.51,
      text: "$3,174.51",
      formula: "=SUM(B2:B3)",
    });
    expect(cells.find((cell) => cell.cell === "B5")).toMatchObject({ text: "67.7%" });
    expect(read.charts).toEqual([
      {
        id: "chart-1",
        type: "donut",
        title: "Rent is two thirds of spending",
        points: [
          { label: "Rent", value: 2150 },
          { label: "Food", value: 1024.51 },
        ],
      },
    ]);
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("merges an update over the saved sheet and reports formula errors", () =>
  Effect.gen(function* () {
    yield* call("sheet_write", { ...BUDGET, name: "merge-me" });
    const merged = yield* call("sheet_write", {
      name: "merge-me",
      merge: true,
      tabs: [
        { name: "Plan", cells: { B2: 3000, A5: "", B5: "", C1: "=B4/0" } },
        { name: "Notes", cells: { A1: "=Plan!B4" } },
      ],
    });
    expect(merged).toMatchObject({
      created: false,
      title: "Q3 Budget",
      tabs: ["Plan", "Notes"],
      cells: 10,
      charts: 1,
      errors: [{ cell: "Plan!C1", error: "#DIV/0!" }],
    });
    const notes = yield* call("sheet_read", { name: "merge-me", tab: "notes" });
    expect((notes.cells as Array<Record<string, unknown>>)[0]).toMatchObject({ value: 4024.51 });
    expect(yield* call("sheet_write", { name: "absent", merge: true, tabs: [] })).toMatchObject({
      code: "invalid_request",
      message: "No sheet named absent to update.",
    });
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("reads a sparse sheet without walking its empty rectangle", () =>
  Effect.gen(function* () {
    yield* call("sheet_write", {
      title: "Sparse",
      tabs: [
        {
          name: "Far",
          cells: { A1: 1, ZZ100000: "=A1+1" },
          charts: [
            { id: "c", type: "bar", title: "All", labels: "A1:A100000", values: "A1:ZZ100000" },
          ],
        },
      ],
    });
    const read = yield* call("sheet_read", { name: "sparse" });
    expect(read).toMatchObject({ range: "A1:ZZ100000", truncated: false });
    expect(
      (read.cells as Array<Record<string, unknown>>).map((cell) => [cell.cell, cell.value]),
    ).toEqual([
      ["A1", 1],
      ["ZZ100000", 2],
    ]);
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("behaves the same for every provider", () =>
  Effect.gen(function* () {
    const results: Array<Record<string, unknown>> = [];
    for (const provider of ["codex", "claudeAgent", "muse", "acpRegistry_gemini"]) {
      const instanceId = ProviderInstanceId.make(provider);
      const shell = {
        ...caller,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "any-model" },
      };
      results.push(
        yield* call("sheet_write", { ...BUDGET, name: "same" }).pipe(
          Effect.provide(layerFor(scopeFor(provider), shell)),
        ),
      );
    }
    const [first, ...rest] = results.map((result) => ({ ...result, created: true }));
    for (const other of rest) expect(other).toEqual(first);
  }),
);

it.effect("refuses names that leave the folder, bad input and limits, naming each", () =>
  Effect.gen(function* () {
    for (const name of ["../escape", "a/b", "..", "/etc/passwd", "UPPER case", ".hidden"]) {
      expect(yield* call("sheet_write", { ...BUDGET, name }), name).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("A sheet name is lower-case letters"),
      });
      expect(yield* call("sheet_read", { name }), name).toMatchObject({ code: "invalid_request" });
    }
    expect(yield* call("sheet_write", { tabs: BUDGET.tabs })).toMatchObject({
      code: "invalid_request",
      message: "A new sheet needs a title. To change a saved sheet, pass its name and merge.",
    });
    expect(
      yield* call("sheet_write", {
        title: "Long",
        tabs: [{ name: "A", cells: { A1: `=${"1+".repeat(1100)}1` } }],
      }),
    ).toMatchObject({
      code: "invalid_request",
      message: 'Tab "A": the formula in A1 is over the 2000 character limit.',
    });
    expect(
      yield* call("sheet_write", { title: "Bad", tabs: [{ name: "A", cells: { "A1:B2": 1 } }] }),
    ).toMatchObject({
      code: "invalid_request",
      message: 'Tab "A": "A1:B2" is not a cell address.',
    });
    expect(yield* call("sheet_read", { name: "nope" })).toMatchObject({
      code: "invalid_request",
      message: "No sheet named nope in this project.",
    });
    expect(yield* call("sheet_read", { name: "q3-budget", tab: "Missing" })).toMatchObject({
      code: "invalid_request",
      message: "No tab named Missing in this sheet. Tabs: Plan.",
    });
    expect(NodeFS.existsSync(NodePath.join(root, ".specweave/escape.sheet.json"))).toBe(false);
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("never writes or reads through a link", () =>
  Effect.gen(function* () {
    // The artifacts folder itself is a link to a folder outside the project.
    const linked = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "office-mcp-linked-"));
    NodeFS.mkdirSync(NodePath.join(linked, ".specweave"));
    NodeFS.symlinkSync(outside, NodePath.join(linked, ".specweave/artifacts"));
    expect(
      yield* call("sheet_write", BUDGET).pipe(Effect.provide(layerFor(scope, caller, linked))),
    ).toMatchObject({
      code: "invalid_request",
      message: ".specweave/artifacts leads outside the project.",
    });
    expect(NodeFS.readdirSync(outside)).toEqual([]);
    NodeFS.rmSync(linked, { recursive: true, force: true });

    // A sheet file that is a link to a file outside the project.
    const secret = NodePath.join(outside, "secret.json");
    NodeFS.writeFileSync(
      secret,
      JSON.stringify({ title: "Secret", tabs: [{ name: "S", cells: { A1: "token" } }] }),
    );
    NodeFS.symlinkSync(secret, NodePath.join(root, ".specweave/artifacts/leak.sheet.json"));
    expect(yield* call("sheet_read", { name: "leak" })).toMatchObject({ code: "invalid_request" });
    expect(yield* call("sheet_write", { ...BUDGET, name: "leak" })).toMatchObject({
      code: "invalid_request",
    });
    expect(JSON.parse(NodeFS.readFileSync(secret, "utf8")).title).toBe("Secret");
    NodeFS.unlinkSync(NodePath.join(root, ".specweave/artifacts/leak.sheet.json"));
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("refuses a thread that plans or asks before it edits files, but lets it read", () =>
  Effect.gen(function* () {
    const approval = liveThreadShell(caller.id, { runtimeMode: "approval-required" });
    expect(
      yield* call("sheet_write", BUDGET).pipe(Effect.provide(layerFor(scope, approval))),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("This thread asks before it changes files."),
    });
    const plan = liveThreadShell(caller.id, {
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
    expect(
      yield* call("sheet_write", BUDGET).pipe(Effect.provide(layerFor(scope, plan))),
    ).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("Plan mode cannot write files."),
    });
    expect(
      yield* call("sheet_read", { name: "q3-budget" }).pipe(Effect.provide(layerFor(scope, plan))),
    ).toMatchObject({ title: "Q3 Budget" });
  }),
);

it.effect("refuses an MCP client outside a thread", () =>
  Effect.gen(function* () {
    expect(yield* call("sheet_write", BUDGET)).toMatchObject({
      code: "thread_credential_required",
    });
    expect(yield* call("sheet_read", { name: "q3-budget" })).toMatchObject({
      code: "thread_credential_required",
    });
  }).pipe(Effect.provide(layerFor({ ...scope, thread: undefined }))),
);

it.effect("enforces expectedRevision compare-and-set and recovers stale lockfiles", () =>
  Effect.gen(function* () {
    const created = yield* call("sheet_write", { ...BUDGET, name: "cas-sheet" });
    expect(typeof created.revision).toBe("string");
    const rev1 = created.revision as string;

    const read1 = yield* call("sheet_read", { name: "cas-sheet" });
    expect(read1.revision).toBe(rev1);

    // Matching expectedRevision succeeds and advances revision.
    const updated = yield* call("sheet_write", {
      name: "cas-sheet",
      merge: true,
      expectedRevision: rev1,
      tabs: [{ name: "Plan", cells: { B2: 2400 } }],
    });
    expect(typeof updated.revision).toBe("string");
    expect(updated.revision).not.toBe(rev1);

    // Stale expectedRevision is rejected without clobbering the file.
    const conflict = yield* call("sheet_write", {
      name: "cas-sheet",
      merge: true,
      expectedRevision: rev1,
      tabs: [{ name: "Plan", cells: { B2: 9999 } }],
    });
    expect(conflict).toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("Conflict:"),
    });
    const afterConflict = yield* call("sheet_read", { name: "cas-sheet" });
    expect(
      (afterConflict.cells as Array<Record<string, unknown>>).find((c) => c.cell === "B2"),
    ).toMatchObject({ value: 2400 });

    // No sidecar .lock or .recover files are left in .specweave/artifacts.
    const artifactEntries = NodeFS.readdirSync(NodePath.join(root, ".specweave/artifacts"));
    expect(artifactEntries.some((entry) => entry.endsWith(".lock") || entry.endsWith(".recover"))).toBe(
      false,
    );
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("enforces kernel-released cross-process lock and recovers immediately after SIGKILL", () =>
  Effect.gen(function* () {
    const created = yield* call("sheet_write", { ...BUDGET, name: "live-lock-sheet" });
    const targetPath = NodePath.join(
      NodeFS.realpathSync(NodePath.join(root, ".specweave/artifacts")),
      "live-lock-sheet.sheet.json",
    );
    const lockIdentity = yield* Effect.promise(() => resolveSheetLockIdentity(targetPath));
    const lockDbPath = resolveSheetLockDbPath(lockIdentity);

    // Production lock selection must be invariant to HOME / TMPDIR overrides.
    const savedEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TMPDIR: process.env.TMPDIR,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
    };
    const distinctTmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "office-distinct-tmp-"));
    const distinctHome = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "office-distinct-home-"),
    );
    try {
      process.env.HOME = distinctHome;
      process.env.USERPROFILE = distinctHome;
      process.env.TMPDIR = distinctTmp;
      process.env.TEMP = distinctTmp;
      process.env.TMP = distinctTmp;
      expect(resolveSheetLockDbPath(lockIdentity)).toBe(lockDbPath);
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }

    // Spawn a real child process holding an exclusive SQLite kernel lock on the sheet
    // under distinct HOME and TMPDIR values to prove lock coordination uses the shared
    // host lock path and ignores per-process environment overrides.
    const holder = NodeChildProcess.spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("BEGIN EXCLUSIVE;"); process.stdout.write("LOCKED\\n"); setInterval(() => {}, 1000);`,
        lockDbPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          HOME: distinctHome,
          USERPROFILE: distinctHome,
          TMPDIR: distinctTmp,
          TEMP: distinctTmp,
          TMP: distinctTmp,
        },
      },
    );

    try {
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            holder.stdout.once("data", () => resolve());
            holder.once("exit", (code) =>
              reject(new Error(`lock holder exited early with code ${code}`)),
            );
          }),
      );

      // While the live child holds the kernel lock, sheet_write must refuse to evict it.
      const blocked = yield* call("sheet_write", {
        name: "live-lock-sheet",
        merge: true,
        expectedRevision: created.revision,
        tabs: [{ name: "Plan", cells: { B2: 2600 } }],
      });
      expect(blocked).toMatchObject({
        code: "invalid_request",
        message: expect.stringContaining("currently being written by another process"),
      });

      // Abruptly kill the holder with SIGKILL: OS kernel releases the lock immediately.
      holder.kill("SIGKILL");
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            holder.once("exit", () => resolve());
          }),
      );

      const recovered = yield* call("sheet_write", {
        name: "live-lock-sheet",
        merge: true,
        expectedRevision: created.revision,
        tabs: [{ name: "Plan", cells: { B2: 2700 } }],
      });
      expect(recovered).toMatchObject({ name: "live-lock-sheet", created: false });
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        holder.kill("SIGKILL");
      }
      NodeFS.rmSync(distinctTmp, { recursive: true, force: true });
      NodeFS.rmSync(distinctHome, { recursive: true, force: true });
    }
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("enforces compare-and-set on viewer saves via writeSheetFileCompareAndSet", () =>
  Effect.gen(function* () {
    const created = yield* call("sheet_write", { ...BUDGET, name: "viewer-cas" });
    const relativePath = ".specweave/artifacts/viewer-cas.sheet.json";
    const fullPath = NodePath.join(root, relativePath);
    const raw = NodeFS.readFileSync(fullPath, "utf8");

    // A viewer save with a stale expectedRevision fails with Conflict and leaves the file intact.
    const staleError = yield* Effect.promise(async () => {
      try {
        await writeSheetFileCompareAndSet(
          root,
          relativePath,
          raw.replace("10000", "99999"),
          "r1-stale0000000000",
        );
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });
    expect(staleError).toContain("Conflict:");
    expect(NodeFS.readFileSync(fullPath, "utf8")).toBe(raw);

    // A viewer save with the matching revision succeeds.
    expect(typeof created.revision).toBe("string");
    const createdRevision = created.revision as string;
    const updatedContents = raw.replace("2150", "3500");
    yield* Effect.promise(() =>
      writeSheetFileCompareAndSet(root, relativePath, updatedContents, createdRevision),
    );
    const read = yield* call("sheet_read", { name: "viewer-cas" });
    const cells = read.cells as Array<Record<string, unknown>>;
    expect(cells.find((cell) => cell.cell === "B2")?.value).toBe(3500);

    // Non-canonical .sheet.json filename stays on its exact path instead of redirecting.
    const nonCanonicalRel = ".specweave/artifacts/My Sheet.sheet.json";
    const nonCanonicalFull = NodePath.join(root, nonCanonicalRel);
    const canonicalFull = NodePath.join(root, ".specweave/artifacts/my-sheet.sheet.json");
    yield* Effect.promise(() => writeSheetFileCompareAndSet(root, nonCanonicalRel, updatedContents));
    expect(NodeFS.existsSync(nonCanonicalFull)).toBe(true);
    expect(NodeFS.existsSync(canonicalFull)).toBe(false);

    // Concurrent writes across case aliases (canonical lowercase vs mixed-case) serialize
    // through the same lock identity so on case-insensitive volumes CAS cannot race.
    const currentAfterWrite = yield* call("sheet_read", { name: "viewer-cas" });
    const revBeforeRace = currentAfterWrite.revision as string;
    const rawNow = NodeFS.readFileSync(fullPath, "utf8");
    const caseAliasRel = ".specweave/artifacts/Viewer-Cas.sheet.json";
    const raceResults = yield* Effect.promise(() =>
      Promise.allSettled([
        writeSheetFileCompareAndSet(root, relativePath, rawNow.replace("3500", "4100"), revBeforeRace),
        writeSheetFileCompareAndSet(root, caseAliasRel, rawNow.replace("3500", "4200"), revBeforeRace),
      ]),
    );
    const fulfilled = raceResults.filter((r) => r.status === "fulfilled");
    const rejected = raceResults.filter((r) => r.status === "rejected");
    // On case-insensitive filesystems (macOS/Windows), both paths hit the same inode and
    // serialized CAS guarantees exactly one succeeds and the other gets Conflict.
    // On case-sensitive filesystems, Viewer-Cas.sheet.json does not exist yet so CAS also rejects it.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain("Conflict:");
  }).pipe(Effect.provide(layerFor(scope))),
);

it.effect("publishes POSIX lock file with 0666 mode even under umask 0077", () =>
  Effect.gen(function* () {
    if (process.platform === "win32") {
      return;
    }
    const previousMask = process.umask(0o077);
    try {
      const sheetName = `umask-lock-${Date.now()}`;
      yield* call("sheet_write", { ...BUDGET, name: sheetName });
      const targetPath = NodePath.join(
        NodeFS.realpathSync(NodePath.join(root, ".specweave/artifacts")),
        `${sheetName}.sheet.json`,
      );
      const lockIdentity = yield* Effect.promise(() => resolveSheetLockIdentity(targetPath));
      const lockDbPath = resolveSheetLockDbPath(lockIdentity);
      const dbMode = NodeFS.lstatSync(lockDbPath).mode & 0o777;
      const dirMode = NodeFS.lstatSync(NodePath.dirname(lockDbPath)).mode & 0o7777;
      expect(dbMode).toBe(0o666);
      expect(dirMode).toBe(0o1777);
    } finally {
      process.umask(previousMask);
    }
  }).pipe(Effect.provide(layerFor(scope))),
);
