// @effect-diagnostics nodeBuiltinImport:off - Makes links in a scratch folder.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OfficeDocument } from "@specweave-studio/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { documentBuild, documentOpen, documentSave } from "./OfficeDocumentEdit.ts";

const layerTest = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "studio-office-document-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const doc = (text: string): OfficeDocument => ({
  blocks: [
    { type: "heading", level: 1, runs: [{ text: "Title" }] },
    { type: "paragraph", runs: [{ text }] },
  ],
});

describe("document editor RPCs", () => {
  it.effect("creates, opens, saves with a revision check and refuses a stale save", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-docx-edit-" });
      const file = path.join(root, ".specweave", "artifacts", "notes.docx");

      const created = yield* documentSave({ path: file, document: doc("First"), mode: "create" });
      const again = yield* documentSave({ path: file, document: doc("Other"), mode: "create" }).pipe(
        Effect.flip,
      );
      expect(again.code).toBe("conflict");

      const opened = yield* documentOpen({ path: file });
      const inode = NodeFS.statSync(file).ino;
      expect(opened.revision).toBe(created.revision);
      expect(opened.document).toEqual(doc("First"));
      expect(opened.lossOnSave).toEqual([]);

      const saved = yield* documentSave({
        path: file,
        document: doc("Second"),
        mode: "replace",
        expectedRevision: opened.revision,
      });
      expect(saved.revision).not.toBe(opened.revision);
      expect((yield* documentOpen({ path: file })).document).toEqual(doc("Second"));
      // Written through the checked file itself: the same file, and nothing left beside it.
      expect(NodeFS.statSync(file).ino).toBe(inode);
      expect(NodeFS.readdirSync(path.dirname(file))).toEqual(["notes.docx"]);

      const stale = yield* documentSave({
        path: file,
        document: doc("Third"),
        mode: "replace",
        expectedRevision: opened.revision,
      }).pipe(Effect.flip);
      expect(stale.code).toBe("conflict");
      expect((yield* documentOpen({ path: file })).document).toEqual(doc("Second"));

      const built = yield* documentBuild({ document: doc("Export"), basePath: file });
      expect(Buffer.from(built.base64, "base64").subarray(0, 2).toString()).toBe("PK");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("writes only .docx files and never through a link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-docx-guard-" });
      const text = path.join(root, "notes.txt");
      const wrongKind = yield* documentSave({ path: text, document: doc("x"), mode: "create" }).pipe(
        Effect.flip,
      );
      expect(wrongKind.code).toBe("invalid");
      const relative = yield* documentSave({
        path: "notes.docx",
        document: doc("x"),
        mode: "create",
      }).pipe(Effect.flip);
      expect(relative.code).toBe("invalid");

      const real = path.join(root, "real.docx");
      yield* documentSave({ path: real, document: doc("Real"), mode: "create" });
      const blind = yield* documentSave({ path: real, document: doc("Blind"), mode: "replace" }).pipe(
        Effect.flip,
      );
      expect(blind.code).toBe("invalid");
      // Windows needs a privilege to make links; the guard is the same there.
      if (process.platform === "win32") return;
      const link = path.join(root, "link.docx");
      NodeFS.symlinkSync(real, link);
      const opened = yield* documentOpen({ path: real });
      const throughLink = yield* documentSave({
        path: link,
        document: doc("Hijack"),
        mode: "replace",
        expectedRevision: opened.revision,
      }).pipe(Effect.flip);
      expect(throughLink.code).toBe("forbidden");
      expect((yield* documentOpen({ path: real })).document).toEqual(doc("Real"));

      const invalid = yield* documentSave({
        path: real,
        document: { blocks: [{ type: "nope" }] } as unknown as OfficeDocument,
        mode: "replace",
      }).pipe(Effect.flip);
      expect(invalid.code).toBe("invalid");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("lets only one of two saves through two names of one file pass the revision check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "studio-docx-edit-" });
      const file = path.join(root, "one.docx");
      const alias = path.join(root, "other-name.docx");
      const created = yield* documentSave({ path: file, document: doc("Start"), mode: "create" });
      NodeFS.linkSync(file, alias);
      const results = yield* Effect.all(
        [file, alias].map((target, index) =>
          documentSave({
            path: target,
            document: doc(`Edit ${index}`),
            mode: "replace",
            expectedRevision: created.revision,
          }).pipe(Effect.result),
        ),
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const failure = results.find((result) => result._tag === "Failure");
      expect(failure?._tag === "Failure" ? failure.failure.code : null).toBe("conflict");
    }).pipe(Effect.provide(layerTest)),
  );
});
