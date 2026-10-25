// @effect-diagnostics nodeBuiltinImport:off - Plants source files in the fixture checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  WS_METHODS,
  WsDesignSystemImportRpcGroup,
  type AuthEnvironmentScope,
  type DesignError,
  type DesignSystemSource,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as Authorization from "../../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../../observability/RpcInstrumentation.ts";
import * as DesignService from "../DesignService.ts";
import {
  agentIn,
  layerDesignService,
  makeDesignFixture,
  member,
  owner,
  PROJECT_A,
  PROJECT_B,
  type DesignFixture,
} from "../DesignService.testkit.ts";
import * as Store from "../DesignStore.ts";
import * as DesignSystemEditing from "./DesignSystemEditing.ts";
import * as DesignSystemRpc from "./DesignSystemRpc.ts";
import { DesignSystemProposals } from "./DesignSystemService.ts";
import * as DesignSystems from "./adapters.ts";

const projectA = { kind: "project", projectId: PROJECT_A } as const;
const projectB = { kind: "project", projectId: PROJECT_B } as const;
const playground = { kind: "playground" } as const;
const agentA = agentIn(PROJECT_A);

const withEditing = <A, E>(
  run: (
    editing: DesignSystemEditing.DesignSystemEditing["Service"],
    designs: DesignService.DesignService["Service"],
    fixture: DesignFixture,
  ) => Effect.Effect<A, E>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      Effect.gen(function* () {
        return yield* run(
          yield* DesignSystemEditing.DesignSystemEditing,
          yield* DesignService.DesignService,
          fixture,
        );
      }).pipe(
        Effect.provide(
          DesignSystems.layerEditing.pipe(Layer.provideMerge(layerDesignService(fixture))),
        ),
      ),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const failure = <A>(effect: Effect.Effect<A, DesignError>) => Effect.flip(effect);

const base64 = (text: string | Uint8Array) => Buffer.from(text).toString("base64");

/** Records `sources` on a system, as a confirmed import would. */
const recordSources = (
  designs: DesignService.DesignService["Service"],
  systemId: string,
  locations: readonly string[],
) =>
  Effect.gen(function* () {
    const { root } = yield* designs.findOwnerRoot(owner, projectA);
    const current = yield* Effect.promise(() => Store.readDesignSystem(root, systemId));
    const readAt = "2026-10-24T10:00:00.000Z";
    const sources: DesignSystemSource[] = [
      ...locations.map((location) => ({ kind: "file" as const, location, readAt })),
      // Only `file` sources name paths in the checkout.
      { kind: "agent", location: "src/other.css", readAt },
    ];
    yield* Effect.promise(() =>
      Store.writeDesignSystem(
        root,
        { ...current, sources },
        { expectedRevision: current.revision, actor: { kind: "user" } },
      ),
    );
  });

const plant = (fixture: DesignFixture, relative: string, contents: string) => {
  const file = NodePath.join(fixture.roots[PROJECT_A]!, relative);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
};

describe("DesignSystemEditing create", () => {
  it.effect("starts an empty system with Light and Dark at revision 0", () =>
    withEditing((editing, designs, fixture) =>
      Effect.gen(function* () {
        const created = yield* editing.create(owner, {
          owner: projectA,
          name: "  Brand  ",
          description: "From scratch.",
        });
        expect(created.system).toMatchObject({
          name: "Brand",
          description: "From scratch.",
          revision: 0,
          modes: [
            { id: "light", name: "Light" },
            { id: "dark", name: "Dark" },
          ],
          tokens: [],
          components: [],
          sources: [],
          copiedFrom: null,
        });
        expect(created.ref.path).toBe(`.specweave/design/systems/${created.system.id}/system.json`);
        expect(NodeFS.existsSync(NodePath.join(fixture.roots[PROJECT_A]!, created.ref.path))).toBe(
          true,
        );
        const read = yield* designs.systemGet(owner, {
          owner: projectA,
          systemId: created.system.id,
        });
        expect(read.system.id).toBe(created.system.id);

        const custom = yield* editing.create(member, {
          owner: playground,
          name: "Print",
          modes: [{ id: "default", name: "Default" }],
        });
        expect(custom.system.modes).toEqual([{ id: "default", name: "Default" }]);
        expect(custom.ref.owner.kind).toBe("playground");
      }),
    ),
  );

  it.effect("refuses agents, a blank name and repeated mode ids", () =>
    withEditing((editing) =>
      Effect.gen(function* () {
        expect((yield* failure(editing.create(agentA, { owner: projectA, name: "X" }))).code).toBe(
          "forbidden",
        );
        expect((yield* failure(editing.create(owner, { owner: projectA, name: "  " }))).code).toBe(
          "invalid",
        );
        const repeated = yield* failure(
          editing.create(owner, {
            owner: projectA,
            name: "X",
            modes: [
              { id: "light", name: "Light" },
              { id: "light", name: "Also light" },
            ],
          }),
        );
        expect(repeated.detail).toBe("Two modes have the id light.");
      }),
    ),
  );
});

describe("DesignSystemEditing apply", () => {
  it.effect("stores an edit as the next revision and conflicts on a stale one", () =>
    withEditing((editing) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Brand" });
        const address = { owner: projectA, systemId: system.id };
        const edited = yield* editing.apply(member, {
          ...address,
          expectedRevision: 0,
          operations: [
            { op: "put_token", token: { name: "brand", type: "color", values: { light: "#f00" } } },
          ],
        });
        expect(edited.system.revision).toBe(1);
        expect(edited.system.tokens[0]?.values.dark).toMatchObject({
          raw: "#f00",
          resolved: "#f00",
          provenance: { source: "user", location: "editor", extractor: "editor@1" },
        });

        const stale = yield* failure(
          editing.apply(owner, {
            ...address,
            expectedRevision: 0,
            operations: [{ op: "delete_token", name: "brand" }],
          }),
        );
        expect(stale).toMatchObject({ code: "conflict", currentRevision: 1 });

        const refused = yield* failure(
          editing.apply(owner, {
            ...address,
            expectedRevision: 1,
            operations: [
              { op: "delete_token", name: "brand" },
              { op: "delete_token", name: "brand" },
            ],
          }),
        );
        expect(refused).toMatchObject({
          code: "not_found",
          detail: "Operation 2: No token brand.",
        });
      }),
    ),
  );

  it.effect("refuses agents, even in their own project", () =>
    withEditing((editing) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Brand" });
        const refused = yield* failure(
          editing.apply(agentA, {
            owner: projectA,
            systemId: system.id,
            expectedRevision: 0,
            operations: [{ op: "set_info", name: "Hijacked" }],
          }),
        );
        expect(refused.code).toBe("forbidden");
        const address = { owner: projectA, systemId: system.id };
        const writes: ReadonlyArray<Effect.Effect<void, DesignError>> = [
          Effect.asVoid(
            editing.filePut(agentA, { ...address, path: "README.md", data: base64("x") }),
          ),
          Effect.asVoid(editing.fileDelete(agentA, { ...address, path: "README.md" })),
          Effect.asVoid(
            editing.fileMove(agentA, { ...address, from: "README.md", to: "Guide.md" }),
          ),
        ];
        for (const write of writes) {
          expect((yield* failure(write)).code).toBe("forbidden");
        }
        // Reading stays open to the agent of the owning project, and closed to others.
        expect((yield* editing.files(agentA, address)).files).toEqual([]);
        expect((yield* failure(editing.files(agentIn(PROJECT_B), address))).code).toBe("forbidden");
      }),
    ),
  );
});

describe("DesignSystemEditing source files", () => {
  it.effect("reads only the files the system lists, through the root-confined reader", () =>
    withEditing((editing, designs, fixture) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Weave" });
        plant(fixture, "src/tokens.css", ":root { --ink: #111; }");
        plant(fixture, "src/other.css", ":root { --secret: 1; }");
        plant(fixture, ".env", "TOKEN=abc");
        plant(fixture, "keys/deploy.pem", "-----BEGIN-----");
        NodeFS.mkdirSync(NodePath.join(fixture.roots[PROJECT_A]!, "src/components"));
        yield* recordSources(designs, system.id, [
          "src/tokens.css",
          ".env",
          "keys/deploy.pem",
          "src/gone.css",
          "src/components",
        ]);
        const address = { owner: projectA, systemId: system.id };

        const read = yield* editing.fileRead(owner, {
          ...address,
          origin: "source",
          path: "src/tokens.css",
        });
        expect(read).toMatchObject({
          encoding: "utf8",
          data: ":root { --ink: #111; }",
          file: { path: "src/tokens.css", origin: "source", mimeType: "text/css", bytes: 22 },
        });

        const unlisted = yield* failure(
          editing.fileRead(owner, { ...address, origin: "source", path: "src/other.css" }),
        );
        expect(unlisted.code).toBe("forbidden");
        const traversal = yield* failure(
          editing.fileRead(owner, { ...address, origin: "source", path: "../project-b/x.css" }),
        );
        expect(traversal.code).toBe("forbidden");
        for (const excluded of [".env", "keys/deploy.pem"]) {
          const refused = yield* failure(
            editing.fileRead(owner, { ...address, origin: "source", path: excluded }),
          );
          expect(refused.code).toBe("forbidden");
          expect(refused.detail).toContain("Never read");
        }

        const listed = yield* editing.files(owner, address);
        expect(
          listed.files.map((file) => [file.path, file.origin, file.unavailable ?? null]),
        ).toEqual([
          [".env", "source", expect.stringContaining("Never read")],
          ["keys/deploy.pem", "source", expect.stringContaining("Never read")],
          ["src/components", "source", "A folder, not a file."],
          ["src/gone.css", "source", "Missing from the checkout."],
          ["src/tokens.css", "source", null],
        ]);
        expect(listed.files.at(-1)).toMatchObject({ bytes: 22, mimeType: "text/css" });
      }),
    ),
  );

  it.effect("has no source files in the Playground", () =>
    withEditing((editing) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: playground, name: "Print" });
        const refused = yield* failure(
          editing.fileRead(owner, {
            owner: playground,
            systemId: system.id,
            origin: "source",
            path: "src/tokens.css",
          }),
        );
        expect(refused.code).toBe("invalid");
      }),
    ),
  );
});

describe("DesignSystemEditing stored files", () => {
  it.effect("reads text as UTF-8 and everything else as base64", () =>
    withEditing((editing) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Weave" });
        const address = { owner: projectA, systemId: system.id };
        const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
        yield* editing.filePut(member, {
          ...address,
          path: "README.md",
          data: base64("# Weave ✓"),
        });
        yield* editing.filePut(owner, {
          ...address,
          path: "assets/Logos/mark.png",
          data: base64(png),
        });

        const readme = yield* editing.fileRead(owner, {
          ...address,
          origin: "stored",
          path: "README.md",
        });
        expect(readme).toMatchObject({ encoding: "utf8", data: "# Weave ✓" });
        const mark = yield* editing.fileRead(owner, {
          ...address,
          origin: "stored",
          path: "assets/Logos/mark.png",
        });
        expect(mark).toMatchObject({
          encoding: "base64",
          data: base64(png),
          file: { mimeType: "image/png", bytes: 10, origin: "stored" },
        });

        const listed = yield* editing.files(owner, address);
        expect(listed.files.map((file) => file.path)).toEqual([
          "README.md",
          "assets/Logos/mark.png",
        ]);
        expect(listed.usedBytes).toBe(Buffer.byteLength("# Weave ✓") + 10);
        expect(listed).toMatchObject({ limitBytes: 1024 * 1024 * 1024, limitFiles: 5_000 });

        const bad = yield* failure(
          editing.filePut(owner, { ...address, path: "a.md", data: "not base64!" }),
        );
        expect(bad).toMatchObject({ code: "invalid", detail: "The file data is not base64." });
      }),
    ),
  );

  it.effect("moves and renames within the files, never over another file", () =>
    withEditing((editing, designs) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Weave" });
        const address = { owner: projectA, systemId: system.id };
        yield* editing.filePut(owner, { ...address, path: "README.md", data: base64("a") });
        yield* editing.filePut(owner, {
          ...address,
          path: "assets/Logos/mark.svg",
          data: base64("<svg/>"),
        });

        const renamed = yield* editing.fileMove(owner, {
          ...address,
          from: "README.md",
          to: "Guide.md",
        });
        expect(renamed.file).toMatchObject({ path: "Guide.md", bytes: 1 });
        yield* editing.fileMove(owner, {
          ...address,
          from: "assets/Logos/mark.svg",
          to: "assets/Brand/mark.svg",
        });
        expect((yield* editing.files(owner, address)).files.map((file) => file.path)).toEqual([
          "Guide.md",
          "assets/Brand/mark.svg",
        ]);
        const { root } = yield* designs.findOwnerRoot(owner, projectA);
        const assets = NodePath.join(root, "systems", system.id, "files", "assets");
        expect(NodeFS.readdirSync(assets)).toEqual(["Brand"]);

        const onto = yield* failure(
          editing.fileMove(owner, { ...address, from: "Guide.md", to: "assets/Brand/mark.svg" }),
        );
        expect(onto.code).toBe("conflict");
        const missing = yield* failure(
          editing.fileMove(owner, { ...address, from: "nope.md", to: "other.md" }),
        );
        expect(missing.code).toBe("not_found");
        const escape = yield* failure(
          editing.fileMove(owner, { ...address, from: "Guide.md", to: "../system.json" }),
        );
        expect(escape.code).toBe("invalid");
      }),
    ),
  );

  it.effect("deletes a file and the folders it leaves empty", () =>
    withEditing((editing, designs) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Weave" });
        const address = { owner: projectA, systemId: system.id };
        yield* editing.filePut(owner, {
          ...address,
          path: "assets/Icons/Arrows/left.svg",
          data: base64("<svg/>"),
        });
        yield* editing.filePut(owner, { ...address, path: "assets/cover.png", data: base64("x") });
        const { root } = yield* designs.findOwnerRoot(owner, projectA);
        const files = NodePath.join(root, "systems", system.id, "files");

        expect(
          (yield* editing.fileDelete(owner, { ...address, path: "assets/Icons/Arrows/left.svg" }))
            .deleted,
        ).toBe(true);
        expect(NodeFS.readdirSync(NodePath.join(files, "assets"))).toEqual(["cover.png"]);
        yield* editing.fileDelete(owner, { ...address, path: "assets/cover.png" });
        expect(NodeFS.readdirSync(files)).toEqual([]);
        expect(
          (yield* editing.fileDelete(owner, { ...address, path: "assets/cover.png" })).deleted,
        ).toBe(false);
      }),
    ),
  );

  it.effect("copies stored files with a system, and removes them with it", () =>
    withEditing((editing, designs) =>
      Effect.gen(function* () {
        const { system } = yield* editing.create(owner, { owner: projectA, name: "Weave" });
        const address = { owner: projectA, systemId: system.id };
        yield* editing.filePut(owner, { ...address, path: "README.md", data: base64("# Weave") });
        yield* editing.filePut(owner, {
          ...address,
          path: "fonts/Inter.woff2",
          data: base64("ff"),
        });

        const copy = yield* designs.systemCopy(owner, { ...address, to: projectB });
        const copied = yield* editing.files(owner, { owner: projectB, systemId: copy.system.id });
        expect(copied.files.map((file) => file.path)).toEqual(["README.md", "fonts/Inter.woff2"]);
        const readme = yield* editing.fileRead(owner, {
          owner: projectB,
          systemId: copy.system.id,
          origin: "stored",
          path: "README.md",
        });
        expect(readme.data).toBe("# Weave");

        const { root } = yield* designs.findOwnerRoot(owner, projectA);
        yield* designs.systemRemove(owner, { ...address, expectedRevision: 0 });
        expect(NodeFS.existsSync(NodePath.join(root, "systems", system.id))).toBe(false);
        expect((yield* failure(editing.files(owner, address))).code).toBe("not_found");
      }),
    ),
  );
});

/** A client of the real `designSystem.*` group, as `makeWsLayers` composes it. */
const clientFor = (scopes: ReadonlyArray<AuthEnvironmentScope>) =>
  RpcTest.makeClient(WsDesignSystemImportRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(DesignSystemRpc.layerRpcHandlers(owner), Authorization.layer(scopes)).pipe(
        Layer.provide(rpcInstrumentationLayer),
        Layer.provide(Layer.merge(DesignSystems.layer, DesignSystems.layerEditing)),
        Layer.provide(Layer.succeed(DesignSystemProposals, new Map())),
      ),
    ),
  );

describe("DesignSystemRpc editing handlers", () => {
  it.effect("serve create, apply and files, and need the write scope to write", () =>
    withEditing((_editing, designs) =>
      Effect.gen(function* () {
        const writer = yield* clientFor([AuthFilesystemReadScope, AuthFilesystemWriteScope]);
        const { system } = yield* writer[WS_METHODS.designSystemCreate]({
          owner: projectA,
          name: "Weave",
        });
        const address = { owner: projectA, systemId: system.id };
        const applied = yield* writer[WS_METHODS.designSystemApply]({
          ...address,
          expectedRevision: 0,
          operations: [{ op: "put_mode", mode: { id: "contrast", name: "Contrast" } }],
        });
        expect(applied.system.modes.map((mode) => mode.id)).toEqual(["light", "dark", "contrast"]);
        yield* writer[WS_METHODS.designSystemFilePut]({
          ...address,
          path: "README.md",
          data: base64("# Weave"),
        });

        const reader = yield* clientFor([AuthFilesystemReadScope]);
        expect(
          yield* reader[WS_METHODS.designSystemFilePut]({
            ...address,
            path: "notes.md",
            data: base64("no"),
          }).pipe(Effect.flip),
        ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
        const listed = yield* reader[WS_METHODS.designSystemFiles](address);
        expect(listed.files.map((file) => file.path)).toEqual(["README.md"]);
        const read = yield* reader[WS_METHODS.designSystemFileRead]({
          ...address,
          origin: "stored",
          path: "README.md",
        });
        expect(read.data).toBe("# Weave");
      }).pipe(Effect.scoped, Effect.provideService(DesignService.DesignService, designs)),
    ),
  );
});
