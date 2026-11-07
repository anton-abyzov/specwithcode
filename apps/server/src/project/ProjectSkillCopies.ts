/** Bounded, inventory-bound skill copy inspection and explicit reconciliation. */
import type {
  ProjectSkillCopy,
  ProjectSkillCopiesInput,
  ProjectSkillCopiesResult,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { randomBytes, sha256 } from "../nodeCrypto.ts";
import { actionError, type ProjectSkillsActionsDeps } from "./ProjectSkillsActionsCommon.ts";

const MAX_COPY_BYTES = 512 * 1024;
// Shared by all socket handlers: a concurrent reconciliation cannot pass the same preview twice.
const copyWrites = Semaphore.makeUnsafe(1);

export const makeProjectSkillCopies = Effect.fn("ProjectSkillCopies.make")(function* (
  deps: ProjectSkillsActionsDeps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const execute = (
    input: ProjectSkillCopiesInput,
  ): Effect.Effect<
    ProjectSkillCopiesResult,
    import("@specweave-studio/contracts").ProjectSkillsActionError
  > =>
    Effect.gen(function* () {
      const context = yield* deps.resolveRow(input);
      const fail = (detail: string) => actionError(input.projectId, "scope_unsupported", detail);
      const readText = (file: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs
              .open(file, { flag: "r" })
              .pipe(Effect.mapError(() => fail("Could not open the skill copy.")));
            const stat = yield* handle.stat.pipe(
              Effect.mapError(() => fail("Could not inspect the skill copy.")),
            );
            if (stat.type !== "File" || stat.size > BigInt(MAX_COPY_BYTES))
              return yield* fail("This skill copy is not a regular text file below 512 KB.");
            const chunks: Uint8Array[] = [];
            let size = 0;
            while (size <= MAX_COPY_BYTES) {
              const chunk = yield* handle
                .readAlloc(Math.min(65536, MAX_COPY_BYTES + 1 - size))
                .pipe(Effect.mapError(() => fail("Could not read the skill copy.")));
              if (chunk._tag === "None" || chunk.value.byteLength === 0) break;
              chunks.push(chunk.value);
              size += chunk.value.byteLength;
            }
            if (size > MAX_COPY_BYTES) return yield* fail("This skill copy is too large.");
            const content = yield* Effect.try({
              try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
              catch: () => fail("This skill copy is not valid UTF-8 text."),
            });
            if (content.includes("\0")) return yield* fail("This skill copy is not text.");
            const currentPath = yield* fs
              .realPath(file)
              .pipe(
                Effect.mapError(() =>
                  fail("The skill copy changed while reading. Refresh and try again."),
                ),
              );
            if (currentPath !== file)
              return yield* fail("The skill copy changed while reading. Refresh and try again.");
            return content;
          }),
        );
      const roots = yield* Effect.forEach([context.cwd, deps.home], (root) =>
        fs.realPath(root).pipe(Effect.option),
      );
      const within = (file: string) =>
        roots.some(
          (root) =>
            root._tag === "Some" &&
            (file === root.value || file.startsWith(`${root.value}${path.sep}`)),
        );
      const grouped = new Map<string, { copy: ProjectSkillCopy; originalPaths: string[] }>();
      if (context.row.providers.length > 64)
        return yield* fail("Too many skill copies to inspect safely.");
      for (const presence of context.row.providers) {
        const real = yield* fs
          .realPath(presence.path)
          .pipe(
            Effect.mapError(() => fail("A skill copy is unavailable. Refresh the skill list.")),
          );
        if (!within(real) || path.basename(real).toLowerCase() !== "skill.md")
          return yield* fail("A skill copy is outside the selected project or user folder.");
        const key = `${presence.scope ?? ""}:${real}`;
        const managed =
          presence.pluginVersion != null ||
          /(^|[\\/])(plugins|cache|managed)([\\/]|$)/i.test(real) ||
          /plugin|managed|system|builtin/i.test(presence.scope ?? "");
        const prior = grouped.get(key);
        const agent = {
          instanceId: presence.instanceId,
          label: presence.label,
          provider: presence.driver,
        };
        if (prior) {
          prior.copy = {
            ...prior.copy,
            ...(managed
              ? {
                  writable: false,
                  reason:
                    "This copy is managed by a plugin or system. Update it through its owner.",
                }
              : {}),
            agents: [...prior.copy.agents, agent],
          };
          prior.originalPaths.push(presence.path);
          continue;
        }
        const content = yield* readText(real);
        const id = sha256([key], "hex");
        grouped.set(key, {
          originalPaths: [presence.path],
          copy: {
            id,
            path: real,
            scope: presence.scope,
            agents: [agent],
            version: presence.fileVersion ?? null,
            hash: sha256([content], "hex"),
            content,
            writable: !managed,
            ...(managed
              ? {
                  reason:
                    "This copy is managed by a plugin or system. Update it through its owner.",
                }
              : {}),
          },
        });
      }
      const copies = [...grouped.values()].map((entry) => entry.copy);
      if (input.operation === "read") return { _tag: "read" as const, copies };
      const source = copies.find((copy) => copy.id === input.sourceId);
      const ids = input.targetIds ?? [];
      const targets = ids.map((id) => copies.find((copy) => copy.id === id));
      if (
        !source ||
        !ids.length ||
        new Set(ids).size !== ids.length ||
        targets.some((copy) => !copy || copy.id === source.id)
      )
        return yield* fail("Choose an existing source and distinct destination copies.");
      const chosen = targets as ProjectSkillCopy[];
      if (chosen.some((copy) => !copy.writable))
        return yield* fail(
          "A selected copy is managed by a plugin or system. Update it through its owner.",
        );
      // Canonical duplicate targets would write the same file twice (for example scope aliases).
      if (
        new Set(chosen.map((copy) => copy.path)).size !== chosen.length ||
        chosen.some((copy) => copy.path === source.path)
      )
        return yield* fail(
          "The selected copies refer to the same file. Choose distinct destinations.",
        );
      // Never replace a symlink or traverse a linked directory on a mutation. Reads above may follow safe in-root links.
      for (const copy of chosen) {
        const entry = [...grouped.values()].find((value) => value.copy.id === copy.id)!;
        for (const original of entry.originalPaths) {
          let cursor = path.resolve(original);
          for (;;) {
            if ([context.cwd, deps.home].some((root) => path.resolve(root) === cursor)) break;
            if ((yield* fs.readLink(cursor).pipe(Effect.option))._tag === "Some")
              return yield* fail(
                "A selected copy uses a symbolic link. Edit its canonical source instead.",
              );
            const parent = path.dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
          }
        }
      }
      const expected = {
        sourceHash: source.hash,
        targets: chosen.map((copy) => ({ id: copy.id, hash: copy.hash })),
      };
      if (input.operation === "preview")
        return { _tag: "preview" as const, copies, sourceId: source.id, targetIds: ids, expected };
      const previous = input.expected;
      if (
        !previous ||
        previous.sourceHash !== source.hash ||
        previous.targets.length !== chosen.length ||
        chosen.some(
          (copy) => previous.targets.find((item) => item.id === copy.id)?.hash !== copy.hash,
        )
      )
        return yield* actionError(input.projectId, "stale");
      // All targets are validated before the first mutation. Each file uses an atomic sibling rename.
      for (const copy of chosen) {
        const freshSource = yield* readText(source.path).pipe(
          Effect.mapError(() => actionError(input.projectId, "stale")),
        );
        if (sha256([freshSource], "hex") !== source.hash)
          return yield* actionError(input.projectId, "stale");
        if ((yield* fs.realPath(copy.path).pipe(Effect.orElseSucceed(() => ""))) !== copy.path)
          return yield* actionError(input.projectId, "stale");
        const current = yield* readText(copy.path).pipe(
          Effect.mapError(() => actionError(input.projectId, "stale")),
        );
        if (sha256([current], "hex") !== copy.hash)
          return yield* actionError(input.projectId, "stale");
        const temp = `${copy.path}.reconcile-${randomBytes(12).toString("hex")}`;
        yield* fs.writeFileString(temp, source.content, { flag: "wx", mode: 0o600 }).pipe(
          Effect.andThen(fs.rename(temp, copy.path)),
          Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)),
          Effect.mapError(() =>
            fail(
              "A copy could not be replaced. Refresh to inspect the per-copy contents before retrying.",
            ),
          ),
        );
      }
      yield* deps.afterWrite({
        projectId: context.projectId,
        cwd: context.cwd,
        instanceIds: chosen.flatMap((copy) => copy.agents.map((agent) => agent.instanceId)),
      });
      return {
        _tag: "applied" as const,
        copies: copies.map((copy) =>
          ids.includes(copy.id)
            ? { ...copy, content: source.content, hash: source.hash, version: source.version }
            : copy,
        ),
        sourceId: source.id,
        targetIds: ids,
        expected,
      };
    }).pipe(copyWrites.withPermits(1));
  return { execute };
});
