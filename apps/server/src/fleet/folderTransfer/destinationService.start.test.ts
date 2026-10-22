// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalFetch:off - exercises the production Fetch transport with isolated HTTP concurrency gates.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { DestinationCopies } from "./destinationService.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";
import type { Choice } from "./reconcile.ts";

it.each(["matching", "conflicting"] as const)(
  "serializes %s concurrent starts and preserves applied files and Undo",
  async (details) => {
    const base = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "copy-start-race-")),
    );
    const source = NodePath.join(base, "source");
    const target = NodePath.join(base, "target");
    NodeFS.mkdirSync(source);
    NodeFS.mkdirSync(target);
    NodeFS.writeFileSync(NodePath.join(source, "note.txt"), "source version");
    NodeFS.writeFileSync(NodePath.join(target, "note.txt"), "destination work");
    const sources = new SourceTransfers(NodePath.join(base, "source-state"));
    const served = await serveSource(sources, "source-env");
    const operationId = "00000000-0000-4000-8000-000000000993";
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    let enterSecond!: () => void;
    let releaseSecond!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enterFirst = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondEntered = new Promise<void>((resolve) => {
      enterSecond = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let hellos = 0;
    let registrations = 0;
    const copies = new DestinationCopies(NodePath.join(base, "destination-state"), {
      allowLoopback: true,
      pollMs: 1,
      register: async () => {
        registrations++;
        return "copied-project";
      },
      fetch: async (url, init) => {
        if (String(url).endsWith("/hello")) {
          hellos++;
          if (hellos === 1) {
            enterFirst();
            await firstGate;
          } else {
            enterSecond();
            await secondGate;
            return new Response("{}", { status: 401 });
          }
        }
        return fetch(url, init);
      },
    });
    const settle = async (state: "previewed" | "applied") => {
      for (let attempt = 0; attempt < 200; attempt++) {
        await copies.waitFor(operationId);
        const current = await copies.read(operationId);
        if (current?.state === "failed") throw new Error(current.error?.message);
        if (current?.state === state) return current;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Copy did not reach ${state}`);
    };
    try {
      const offered = await sources.offer({
        operationId,
        projectId: "source-project",
        folder: source,
        mode: "copy-only",
        destinationEnvironmentId: "destination-env",
      });
      const input = {
        operationId,
        sourceUrl: served.url,
        token: offered.token,
        sourceEnvironmentId: "source-env",
        sourceProjectId: "source-project",
        sourceMachine: "Mac",
        mode: "copy-only" as const,
        targetFolder: target,
        title: "Copy",
      };
      const first = copies.start(input);
      await firstEntered;
      // A vulnerable implementation enters hello a second time before either record exists.
      const second = copies
        .start(details === "conflicting" ? { ...input, projectId: "different-project" } : input)
        .then(
          () => ({ code: "success" }),
          (error: unknown) => error,
        );
      await Promise.race([secondEntered, new Promise((resolve) => setTimeout(resolve, 50))]);
      releaseFirst();
      await first;
      await settle("previewed");
      const decisions: Record<string, Choice> = {};
      for (const row of (await copies.readPlan(operationId))!.rows) {
        if (row.needsDecision) decisions[row.id] = "take-theirs";
        for (const conflict of row.conflicts) decisions[conflict.id] = "take-theirs";
      }
      await copies.decide(operationId, { decisions });
      await settle("previewed");
      await copies.approve(operationId);
      const applied = await settle("applied");
      expect(applied).toMatchObject({ committed: true, projectId: "copied-project" });
      const journal = NodePath.join(
        base,
        "destination-state",
        "folder-copies",
        operationId,
        "journal.ndjson",
      );
      const before = NodeFS.readFileSync(journal, "utf8");
      expect(NodeFS.readFileSync(NodePath.join(target, "note.txt"), "utf8")).toBe("source version");
      // A failed delayed handshake must never remove the first start's recovery directory.
      releaseSecond();
      const rejected = await second;
      expect(await copies.read(operationId)).toMatchObject({ state: "applied", committed: true });
      expect(NodeFS.readFileSync(journal, "utf8")).toBe(before);
      expect((await copies.undoPreview(operationId)).items).toContainEqual(
        expect.objectContaining({ path: "note.txt", state: "restore" }),
      );
      expect((await copies.start(input)).projectId).toBe("copied-project");
      expect(registrations).toBe(1);
      expect(hellos).toBe(1);
      expect(rejected).toMatchObject({ code: details === "conflicting" ? "refused" : "success" });
      expect((await copies.undo(operationId, false)).result?.problems).toEqual([]);
      expect(NodeFS.readFileSync(NodePath.join(target, "note.txt"), "utf8")).toBe(
        "destination work",
      );
      expect(NodeFS.readFileSync(NodePath.join(source, "note.txt"), "utf8")).toBe("source version");
    } finally {
      releaseFirst();
      releaseSecond();
      await copies.close();
      await served.close();
      NodeFS.rmSync(base, { recursive: true, force: true });
    }
  },
  30_000,
);
