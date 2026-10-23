import { sha256 } from "../../nodeCrypto.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { ProjectId } from "@specweave-studio/contracts";
import {
  ProjectPlanError,
  type ProjectExternalPlan,
  type ProjectPlanAuthority,
} from "../../../../../packages/contracts/src/projectPlan.ts";
import { exposesProtectedRealPath } from "../ProjectEnvironmentPaths.ts";

const META_EVENTS = new Set(["note", "session", "handoff", "pickup"]);
const LedgerEntry = Schema.Struct({
  t: Schema.String.check(Schema.isMaxLength(64)),
  e: Schema.Literals([
    "claim",
    "done",
    "release",
    "block",
    "skip",
    "note",
    "session",
    "handoff",
    "pickup",
  ]),
  by: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(500)),
  at: Schema.String.check(Schema.isMaxLength(64)),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
  evidence: Schema.optional(Schema.String.check(Schema.isMaxLength(8_192))),
});
type ExternalTask = ProjectExternalPlan["tasks"][number];
const decodeLedgerEntry = Schema.decodeUnknownSync(LedgerEntry);
const isPlanError = Schema.is(ProjectPlanError);

/** Compatible with the 3.0.6 ledger fold, without importing, installing or invoking its CLI.
 * Lease expiry is displayed as stale ownership; this reader never performs a takeover.
 * Unlike the CLI's tolerant display, malformed configured sources fail closed here.
 */
export function parseSpecWeavePlan(spec: string, ledger: string): ProjectExternalPlan["tasks"] {
  const tasks = new Map<string, ExternalTask>();
  let fenced = false;
  for (const line of spec.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^### (T-[A-Za-z0-9_-]+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, id, title] = match;
    if (!id || !title || tasks.has(id) || id.length > 64 || title.length > 500 || tasks.size >= 200)
      throw new Error("Invalid task definitions");
    tasks.set(id, {
      id,
      title,
      status: "planned",
      owner: null,
      evidence: null,
      verification: "external_unverified",
    });
  }
  if (!spec.trim() || tasks.size === 0 || fenced) throw new Error("Missing task definitions");
  const entries = ledger
    .replace(/^\uFEFF/, "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      if (index >= 10_000 || line.length > 20_000) throw new Error("Ledger too large");
      const entry = decodeLedgerEntry(JSON.parse(line));
      if (!/^\d{4}-\d\d-\d\dT/.test(entry.at) || !Number.isFinite(Date.parse(entry.at)))
        throw new Error("Invalid timestamp");
      if (!META_EVENTS.has(entry.e) && !tasks.has(entry.t)) throw new Error("Unknown task");
      if (entry.e === "done" && !entry.evidence?.trim()) throw new Error("Missing evidence");
      if (entry.e === "skip" && !entry.note?.trim()) throw new Error("Missing skip reason");
      return { ...entry, index };
    })
    .sort(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) ||
        (a.by < b.by ? -1 : a.by > b.by ? 1 : a.index - b.index),
    );
  const since = new Map<string, number>();
  for (const entry of entries) {
    if (META_EVENTS.has(entry.e)) continue;
    const task = tasks.get(entry.t)!;
    const terminal = task.status === "done" || task.status === "skipped";
    const heldByOther =
      (task.status === "claimed" || task.status === "blocked") &&
      task.owner !== entry.by &&
      Date.parse(entry.at) - (since.get(entry.t) ?? 0) <= 2 * 3_600_000;
    if (entry.e === "release") {
      if (!terminal && task.owner === entry.by)
        tasks.set(entry.t, { ...task, status: "released", owner: null });
      continue;
    }
    if (heldByOther || (terminal && !(entry.e === "done" && task.status === "done"))) continue;
    const status =
      entry.e === "claim"
        ? "claimed"
        : entry.e === "block"
          ? "blocked"
          : entry.e === "skip"
            ? "skipped"
            : "done";
    tasks.set(entry.t, {
      ...task,
      status,
      owner: entry.by,
      evidence: entry.e === "done" ? entry.evidence! : null,
    });
    since.set(entry.t, Date.parse(entry.at));
  }
  return [...tasks.values()].map((task) =>
    task.status === "claimed" &&
    DateTime.toEpochMillis(DateTime.nowUnsafe()) - (since.get(task.id) ?? 0) > 2 * 3_600_000
      ? { ...task, status: "stale" as const }
      : task,
  );
}

export const readSpecWeavePlan = (input: {
  projectId: ProjectId;
  workspaceRoot: string;
  approvedFolders?: readonly string[];
  authority: Extract<ProjectPlanAuthority, { kind: "specweave" }>;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const invalid = () =>
      new ProjectPlanError({ projectId: input.projectId, code: "source_invalid" });
    const inside = (root: string, file: string) => {
      const relative = path.relative(root, file);
      return (
        relative === "" ||
        (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      );
    };
    if (!path.isAbsolute(input.authority.root)) return yield* invalid();
    const projectRoot = yield* fs.realPath(input.workspaceRoot);
    const root = yield* fs.realPath(input.authority.root);
    const grants = input.approvedFolders ?? [];
    const approved = yield* Effect.forEach(grants, (grant) =>
      Effect.gen(function* () {
        const canonical = yield* fs.realPath(grant);
        if (canonical !== grant || (yield* exposesProtectedRealPath(canonical, path)))
          return yield* invalid();
        return canonical;
      }),
    );
    if (
      root !== input.authority.root ||
      (!inside(projectRoot, root) && !approved.some((grant) => inside(grant, root)))
    )
      return yield* invalid();
    const directory = path.join(root, ".specweave", "increments", input.authority.incrementId);
    const read = (file: string, maximum: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const resolved = yield* fs.realPath(file);
          if (!inside(root, resolved)) return yield* invalid();
          const entry = yield* fs.stat(resolved);
          if (entry.type !== "File" || entry.size > BigInt(maximum)) return yield* invalid();
          const handle = yield* fs.open(resolved, { flag: "r" });
          const before = yield* handle.stat;
          if (before.type !== "File" || before.size > BigInt(maximum)) return yield* invalid();
          const chunks: Uint8Array[] = [];
          let length = 0;
          while (length <= maximum) {
            const next = yield* handle.readAlloc(Math.min(16_384, maximum + 1 - length));
            if (Option.isNone(next)) break;
            chunks.push(next.value);
            length += next.value.byteLength;
            if (next.value.byteLength === 0) break;
          }
          const after = yield* handle.stat;
          for (const grant of approved)
            if ((yield* fs.realPath(grant)) !== grant) return yield* invalid();
          if (
            length > maximum ||
            before.size !== after.size ||
            Option.getOrNull(before.mtime)?.getTime() !==
              Option.getOrNull(after.mtime)?.getTime() ||
            (yield* fs.realPath(file)) !== resolved ||
            (yield* fs.realPath(input.authority.root)) !== root ||
            (yield* fs.realPath(input.workspaceRoot)) !== projectRoot
          )
            return yield* invalid();
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: invalid,
          });
        }),
      );
    const specPath = path.join(directory, "spec.md");
    const ledgerPath = path.join(directory, "ledger.jsonl");
    const spec = yield* read(specPath, 262_144);
    const ledger = yield* read(ledgerPath, 1_048_576);
    const tasks = yield* Effect.try({
      try: () => parseSpecWeavePlan(spec, ledger),
      catch: invalid,
    });
    return {
      spec,
      tasks,
      specPath,
      ledgerPath,
      readOnly: true as const,
      sourceRevision: sha256([spec, "\0", ledger], "hex"),
    };
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.mapError((error) =>
      isPlanError(error)
        ? error
        : new ProjectPlanError({ projectId: input.projectId, code: "source_unavailable" }),
    ),
  );
