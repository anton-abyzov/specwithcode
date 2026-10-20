// @effect-diagnostics nodeBuiltinImport:off -- Tests lay out real project folders and inspect index files with node:fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EventId,
  PROJECT_KNOWLEDGE_MAX_BYTES,
  ProjectId,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import { sha256 } from "../../nodeCrypto.ts";
import * as DiskSpaceMonitor from "../../observability/DiskSpaceMonitor.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { openKnowledgeIndex, PENDING_REVISION } from "./knowledgeIndex.ts";
import * as ProjectKnowledge from "./ProjectKnowledge.ts";

/** A whole service with its own state folder and database; `extra` replaces what it reads at startup. */
const stack = <A>(prefix: string, extra: Layer.Layer<A> = Layer.empty as Layer.Layer<A>) =>
  ProjectKnowledge.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(ProjectStore.layer, OrchestrationEventStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provide(extra),
    Layer.provide(NodeServices.layer),
  );

const layer = stack("project-knowledge-");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) NodeFS.rmSync(root, { recursive: true, force: true });
});

const workspace = (files: Record<string, string>) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "knowledge-ws-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
};
const write = (root: string, path: string, content: string) => {
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(root, path), content);
};

const projectEvent = (projectId: ProjectId, sequence: number) => ({
  sequence,
  eventId: EventId.make(`event-${projectId}-${sequence}`),
  aggregateKind: "project" as const,
  aggregateId: projectId,
  occurredAt: "2026-10-20T00:00:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const seed = (id: string, root: string, memory: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(id);
    yield* (yield* ProjectStore.ProjectStoreV2).apply({
      ...projectEvent(projectId, 1),
      type: "project.created",
      payload: {
        projectId,
        title: id,
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-10-20T00:00:00.000Z",
        updatedAt: "2026-10-20T00:00:00.000Z",
      },
    });
    for (const [name, content] of Object.entries(memory)) yield* remember(projectId, name, content);
    return projectId;
  });

const remember = (projectId: ProjectId, name: string, content: string, revision = 1) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO project_memory (project_id,name,content,revision,updated_at,byte_length) VALUES (${projectId},${name},${content},${revision},'2026-10-20T00:00:00.000Z',${Buffer.byteLength(content)}) ON CONFLICT(project_id,name) DO UPDATE SET content=excluded.content,revision=excluded.revision,byte_length=excluded.byte_length`;
  });

/** Changes something on disk, tells the service and waits for the refresh. */
const changed = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    yield* knowledge.markDirty(projectId);
    yield* knowledge.drain;
  });

const sectioned = (count: number, size: number, marker: (index: number) => string) =>
  Array.from(
    { length: count },
    (_, index) =>
      `## Section ${index + 1}\n\n${marker(index + 1)} ${"lorem ipsum dolor sit amet ".repeat(Math.ceil(size / 27)).slice(0, size)}\n`,
  ).join("\n");

const indexFile = (stateDir: string, projectId: ProjectId) =>
  NodePath.join(stateDir, "knowledge", "v1", `${sha256([projectId], "hex")}.sqlite`);

/** A project hub listing file artifacts, as `specweave` writes it. */
const writeHub = (root: string, artifacts: ReadonlyArray<{ title: string; location: string }>) =>
  write(
    root,
    ".specweave/project/hub.json",
    JSON.stringify({
      version: 1,
      revision: 1,
      updatedAt: null,
      name: "fixture",
      goal: "",
      context: "",
      artifacts: artifacts.map((artifact, index) => ({
        id: `artifact-${index}`,
        title: artifact.title,
        kind: "file",
        location: artifact.location,
        intentId: null,
        createdAt: "2026-10-20T00:00:00.000Z",
      })),
      routines: [],
    }),
  );

it.layer(layer)("Project knowledge", (it) => {
  it.effect(
    "inlines memory and hub artifacts, searches folder files, and switches to search mode past the allowance",
    () =>
      Effect.gen(function* () {
        const root = workspace({
          ".specweave/docs/overview.md":
            "# Overview\n\nThe launch codename is BlueHeron. See AC-01.\n",
          "docs/plan.md": "# Plan\n\nShip retrieval in two steps.\n",
        });
        writeHub(root, [{ title: "Rollout plan", location: "docs/plan.md" }]);
        const projectId = yield* seed("knowledge-modes", root, {
          "decisions.md": "# Decisions\n\nRetrieval uses SQLite FTS5.\n",
          "MEMORY.md": "- [Decisions](decisions.md)\n",
        });
        const knowledge = yield* ProjectKnowledge.ProjectKnowledge;

        const small = yield* knowledge.status({ projectId });
        assert.equal(small.mode, "inline");
        assert.equal(small.state, "ready");
        assert.equal(small.documents, 3, "MEMORY.md is already in every thread's context");
        assert.equal(
          small.bytes,
          [
            "# Overview\n\nThe launch codename is BlueHeron. See AC-01.\n",
            "# Plan\n\nShip retrieval in two steps.\n",
            "# Decisions\n\nRetrieval uses SQLite FTS5.\n",
          ]
            .map((text) => Buffer.byteLength(text))
            .reduce((sum, size) => sum + size, 0),
          "capacity counts the size on disk",
        );
        assert.equal(small.capacityBytes, PROJECT_KNOWLEDGE_MAX_BYTES);
        const inline = yield* knowledge.view(projectId);
        assert.equal(inline?.root, root);
        assert.deepEqual(
          inline?.mode === "inline" ? inline.documents.map((document) => document.id) : [],
          ["memory:decisions.md", "file:docs/plan.md"],
          "Library folder files are searched, never inlined",
        );
        assert.deepEqual(inline?.mode === "inline" ? inline.searchLabels : [], ["Docs"]);
        const codename = yield* knowledge.search({ projectId, query: "What is BlueHeron?" });
        assert.equal(codename.results[0]?.location, ".specweave/docs/overview.md");
        assert.include(codename.results[0]?.excerpt ?? "", "BlueHeron");
        assert.match(codename.results[0]?.modifiedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(
          (yield* knowledge.search({ projectId, query: "ac-01" })).results[0]?.title,
          "Overview",
        );
        for (const [within, count] of [
          [".specweave/docs", 1],
          [`${root}/.specweave/docs/`, 1],
          ["./.specweave/increments", 0],
          ["%", 0],
        ] as const)
          assert.lengthOf(
            (yield* knowledge.search({ projectId, query: "BlueHeron", within })).results,
            count,
            within,
          );

        // A large increment is searched and does not count against the allowance.
        write(
          root,
          ".specweave/increments/0001-big/spec.md",
          `# Big spec\n\n${sectioned(30, 1_000, (index) => (index === 17 ? "zebracrossing" : "plain"))}`,
        );
        yield* changed(projectId);
        assert.equal((yield* knowledge.status({ projectId })).mode, "inline");
        const found = yield* knowledge.search({
          projectId,
          query: "zebracrossing",
          within: ".specweave/increments/0001",
        });
        assert.equal(found.results.length, 1);
        assert.include(found.results[0]!.heading, "Section 17");
        assert.include(found.results[0]!.excerpt, "zebracrossing");
        const page = yield* knowledge.read({ projectId, documentId: found.results[0]!.documentId });
        assert.equal(page.content.length, 16_000);
        assert.equal(page.nextOffset, 16_000);
        const rest = yield* knowledge.read({
          projectId,
          documentId: page.documentId,
          offset: page.nextOffset!,
        });
        assert.isNull(rest.nextOffset);
        assert.equal(
          page.content + rest.content,
          NodeFS.readFileSync(
            NodePath.join(root, ".specweave/increments/0001-big/spec.md"),
            "utf8",
          ),
        );

        yield* remember(projectId, "big.md", "notes ".repeat(5_000), 2);
        yield* changed(projectId);
        const large = yield* knowledge.status({ projectId });
        assert.equal(large.mode, "search");
        assert.isAbove(large.inlineCharacters, large.inlineLimit);
        const catalog = yield* knowledge.view(projectId);
        assert.deepEqual(catalog?.mode === "search" ? catalog.labels : [], [
          "Project memory",
          "Hub artifacts",
          "Docs",
          "Increments",
        ]);
        assert.deepEqual(catalog?.mode === "search" ? catalog.artifactTitles : [], [
          "Rollout plan",
        ]);

        // Between the two bars the project stays in search mode, so it does not flap.
        yield* remember(projectId, "big.md", "notes ".repeat(3_500), 3);
        yield* changed(projectId);
        assert.equal((yield* knowledge.status({ projectId })).mode, "search");
        yield* remember(projectId, "big.md", "Now small.", 4);
        yield* changed(projectId);
        assert.equal((yield* knowledge.status({ projectId })).mode, "inline");
      }),
  );

  it.effect("re-reads only what changed and keeps the index for a restarted service", () =>
    Effect.gen(function* () {
      const root = workspace({
        ".specweave/docs/a.md": "# Alpha\n\nfirst version\n",
        ".specweave/reports/b.md": "# Beta\n\nunchanged\n",
      });
      const projectId = yield* seed("knowledge-restart", root, {
        "notes.md": "remember kiwifruit",
      });
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      assert.equal((yield* knowledge.status({ projectId })).documents, 3);

      write(root, ".specweave/docs/a.md", "# Alpha\n\nsecond version with mangosteen\n");
      yield* remember(projectId, "notes.md", "remember durian", 2);
      yield* changed(projectId);
      assert.equal((yield* knowledge.search({ projectId, query: "mangosteen" })).results.length, 1);
      assert.equal((yield* knowledge.search({ projectId, query: "durian" })).results.length, 1);
      assert.equal((yield* knowledge.search({ projectId, query: "kiwifruit" })).results.length, 0);

      const before = yield* knowledge.status({ projectId });
      const restarted = yield* Effect.gen(function* () {
        return yield* (yield* ProjectKnowledge.ProjectKnowledge).status({ projectId });
      }).pipe(Effect.provide(Layer.fresh(ProjectKnowledge.layer)));
      assert.equal(restarted.mode, before.mode);
      assert.equal(restarted.documents, 3);
      assert.equal(restarted.indexedAt, before.indexedAt, "a restart reads the stored view");
    }),
  );

  it.effect("indexes only Library text inside the project and never follows a symlink", () =>
    Effect.gen(function* () {
      const outside = workspace({
        "secret.md": "SECRETTOKEN outside the project",
        "folder/doc.md": "LINKEDFOLDER outside the project",
      });
      const root = workspace({
        ".specweave/docs/real.md": "visible document",
        "src/notes.md": "NOTLIBRARY text outside the Library folders",
        ".specweave/docs/data.bin": "binary-ish",
        "notes/.private/hidden.md": "HIDDENARTIFACT in a hidden folder",
        "report.html": "<p>HTMLARTIFACT</p>",
        "docs/kept.md": "KEPTARTIFACT listed in the hub",
        ".specweave/increments/_abandoned/0009-old/spec.md": "ABANDONEDTEXT",
        ".specweave/docs/internal/specs/copy.md": "LIVINGSPEC copy of a spec",
        ".specweave/increments/0002-work/reports/task-T-01.txt": "TASKOUTPUT raw command output",
        ".specweave/increments/0002-work/reports/summary.md": "SUMMARYTEXT of the work",
      });
      NodeFS.symlinkSync(
        NodePath.join(outside, "secret.md"),
        NodePath.join(root, ".specweave/docs/link.md"),
      );
      NodeFS.symlinkSync(NodePath.join(outside, "secret.md"), NodePath.join(root, "linked.md"));
      NodeFS.symlinkSync(NodePath.join(outside, "folder"), NodePath.join(root, "through"));
      writeHub(root, [
        { title: "Kept", location: "docs/kept.md" },
        { title: "Link", location: "linked.md" },
        { title: "Through a linked folder", location: "through/doc.md" },
        { title: "Hidden", location: "notes/.private/hidden.md" },
        { title: "Page", location: "report.html" },
        { title: "Escape", location: "../secret.md" },
      ]);
      write(root, ".specweave/docs/huge.md", "h".repeat(2 * 1024 * 1024 + 1));
      const projectId = yield* seed("knowledge-confined", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const status = yield* knowledge.status({ projectId });
      assert.equal(status.documents, 3, "the kept artifact, the real doc and the summary");
      assert.equal(status.skipped.tooLarge, 1);
      for (const query of ["KEPTARTIFACT", "SUMMARYTEXT"])
        assert.lengthOf((yield* knowledge.search({ projectId, query })).results, 1, query);
      for (const query of [
        "SECRETTOKEN",
        "LINKEDFOLDER",
        "NOTLIBRARY",
        "binary",
        "HIDDENARTIFACT",
        "HTMLARTIFACT",
        "ABANDONEDTEXT",
        "LIVINGSPEC",
        "TASKOUTPUT",
      ])
        assert.lengthOf((yield* knowledge.search({ projectId, query })).results, 0, query);
    }),
  );

  it.effect(
    "re-indexes a file pinned to or unpinned from the hub, or retitled, though its bytes stay",
    () =>
      Effect.gen(function* () {
        const root = workspace({
          ".specweave/docs/plan.md":
            "# Plan heading\n\nShip the launch in two steps: pelican first.\n",
        });
        const projectId = yield* seed("knowledge-pinned", root, {
          "notes.md": "# Notes\n\nsmall\n",
        });
        const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
        const sources = Effect.map(knowledge.status({ projectId }), (status) =>
          status.sources.map((source) => `${source.kind}:${source.label}:${source.documents}`),
        );
        const inlineTitles = Effect.map(knowledge.view(projectId), (view) =>
          view?.mode === "inline" ? view.documents.map((document) => document.title) : [],
        );
        assert.deepEqual(yield* sources, ["memory:Project memory:1", "library:Docs:1"]);

        writeHub(root, [{ title: "Launch plan", location: ".specweave/docs/plan.md" }]);
        yield* changed(projectId);
        assert.deepEqual(yield* sources, ["memory:Project memory:1", "artifact:Hub artifacts:1"]);
        assert.deepEqual(yield* inlineTitles, ["notes", "Launch plan"]);

        writeHub(root, [{ title: "Launch plan v2", location: ".specweave/docs/plan.md" }]);
        yield* changed(projectId);
        assert.deepEqual(yield* inlineTitles, ["notes", "Launch plan v2"]);
        const hit = (yield* knowledge.search({ projectId, query: "pelican" })).results[0];
        assert.equal(hit?.title, "Launch plan v2");
        assert.equal(hit?.kind, "artifact");

        writeHub(root, []);
        yield* changed(projectId);
        assert.deepEqual(yield* sources, ["memory:Project memory:1", "library:Docs:1"]);
        assert.equal(
          (yield* knowledge.search({ projectId, query: "pelican" })).results[0]?.title,
          "Plan heading",
        );
      }),
  );

  it.effect("keeps what it had while the project folder cannot be read, and says so", () =>
    Effect.gen(function* () {
      const root = workspace({
        "notes/plan.md": `# Plan\n\n${"narwhal ".repeat(4_000)}`,
        ".specweave/reports/r.md": "# Report\n\nnarwhal sighting\n",
      });
      writeHub(root, [{ title: "Plan", location: "notes/plan.md" }]);
      const projectId = yield* seed("knowledge-unreachable", root, {
        "decisions.md": "# Decisions\n\nnarwhal\n",
      });
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const before = yield* knowledge.status({ projectId });
      assert.equal(before.documents, 3);
      assert.equal(before.mode, "search");

      // As an unmounted drive, a moved folder or a lost permission looks.
      NodeFS.renameSync(root, `${root}-away`);
      yield* changed(projectId);
      const away = yield* knowledge.status({ projectId });
      assert.equal(away.documents, 3, "nothing is taken as deleted");
      assert.equal(away.mode, "search", "the mode does not flip");
      assert.equal(away.state, "failed");
      assert.include(away.problem ?? "", "could not be read");
      const hits = (yield* knowledge.search({ projectId, query: "narwhal" })).results;
      assert.lengthOf(new Set(hits.map((hit) => hit.documentId)), 3);

      NodeFS.renameSync(`${root}-away`, root);
      yield* changed(projectId);
      const back = yield* knowledge.status({ projectId });
      assert.equal(back.state, "ready");
      assert.isNull(back.problem);
      assert.equal(back.documents, 3);

      NodeFS.rmSync(NodePath.join(root, ".specweave/reports/r.md"));
      yield* changed(projectId);
      assert.equal(
        (yield* knowledge.status({ projectId })).documents,
        2,
        "a file known gone leaves",
      );
    }),
  );

  it.effect("returns passages from many documents when one long document matches everywhere", () =>
    Effect.gen(function* () {
      const reports = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `.specweave/reports/r${index}.md`,
          `# Report ${index}\n\nThe rollout went well in region ${index}.\n`,
        ]),
      );
      const root = workspace({
        // Its path names the word, so every passage matches through the title column.
        ".specweave/increments/0864-rollout-plan/spec.md": `# Spec\n\n${sectioned(70, 1_500, () => "plain")}`,
        ...reports,
      });
      const projectId = yield* seed("knowledge-spread", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const found = yield* knowledge.search({ projectId, query: "rollout" });
      assert.lengthOf(found.results, 8);
      assert.isTrue(found.truncated);
      const perDocument = new Map<string, number>();
      for (const hit of found.results)
        perDocument.set(hit.documentId, (perDocument.get(hit.documentId) ?? 0) + 1);
      assert.isAtMost(Math.max(...perDocument.values()), 2);
      assert.isAtLeast(perDocument.size, 7);
      const all = yield* knowledge.search({ projectId, query: "rollout", limit: 20 });
      assert.lengthOf(all.results, 12, "two passages of the spec and every report");
      assert.isFalse(all.truncated);
    }),
  );

  it.effect("moves on through a document by whole surrogate pairs, even a page of one", () =>
    Effect.gen(function* () {
      const projectId = yield* seed("knowledge-emoji", workspace({}), { "emoji.md": "😀 after" });
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      yield* knowledge.status({ projectId });
      const first = yield* knowledge.read({ projectId, documentId: "memory:emoji.md", limit: 1 });
      assert.equal(first.content, "😀");
      assert.equal(first.nextOffset, 2);
      const next = yield* knowledge.read({
        projectId,
        documentId: "memory:emoji.md",
        offset: 2,
        limit: 1,
      });
      assert.equal(next.content, " ");
      assert.equal(next.nextOffset, 3);
    }),
  );

  it.effect("starts a turn without waiting for a rebuild, while a search waits for it", () =>
    Effect.gen(function* () {
      const files = Object.fromEntries(
        Array.from({ length: 400 }, (_, index) => [
          `.specweave/reports/r${index}.md`,
          `# Report ${index}\n\nRoutine notes for item ${index}.\n`,
        ]),
      );
      const root = workspace({ ...files, ".specweave/docs/key.md": "# Key\n\nthe ocelot plan\n" });
      const projectId = yield* seed("knowledge-rebuild-wait", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      assert.equal((yield* knowledge.status({ projectId })).state, "ready");
      yield* knowledge.reindex({ projectId });
      yield* knowledge.ready(projectId);
      assert.equal(
        (yield* knowledge.status({ projectId })).state,
        "indexing",
        "the turn and the status went on while the rebuild runs",
      );
      assert.lengthOf((yield* knowledge.search({ projectId, query: "ocelot" })).results, 1);
      yield* knowledge.drain;
      assert.equal((yield* knowledge.status({ projectId })).state, "ready");
    }),
  );

  it.effect("re-indexes a document a refresh left half written", () =>
    Effect.gen(function* () {
      const root = workspace({ ".specweave/docs/a.md": "# Alpha\n\nonly once: quokka\n" });
      const projectId = yield* seed("knowledge-pending", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      assert.equal((yield* knowledge.status({ projectId })).documents, 1);
      // As if the refresh stopped after marking the document and before its last step.
      const other = openKnowledgeIndex(indexFile(stateDir, projectId), projectId);
      other.write([
        {
          type: "revision",
          id: "file:.specweave/docs/a.md",
          revision: PENDING_REVISION,
          modifiedAt: "2026-10-20T00:00:00.000Z",
        },
      ]);
      yield* changed(projectId);
      const [row] = other.documents();
      other.close();
      assert.notEqual(row?.revision, PENDING_REVISION);
      assert.equal(row?.chunks, 1);
      assert.lengthOf((yield* knowledge.search({ projectId, query: "quokka" })).results, 1);
    }),
  );

  it.effect("replaces a damaged index file and keeps going", () =>
    Effect.gen(function* () {
      const root = workspace({ ".specweave/docs/a.md": "# Alpha\n\nwombat\n" });
      const projectId = ProjectId.make("knowledge-damaged");
      const { stateDir } = yield* ServerConfig.ServerConfig;
      NodeFS.mkdirSync(NodePath.dirname(indexFile(stateDir, projectId)), { recursive: true });
      NodeFS.writeFileSync(indexFile(stateDir, projectId), "this is not a database file at all");
      yield* seed("knowledge-damaged", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const status = yield* knowledge.status({ projectId });
      assert.isNull(status.problem);
      assert.equal(status.documents, 1);
      assert.lengthOf((yield* knowledge.search({ projectId, query: "wombat" })).results, 1);
    }),
  );

  it.effect("creates no index for a project with nothing to index", () =>
    Effect.gen(function* () {
      const projectId = yield* seed("knowledge-empty", workspace({}));
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const status = yield* knowledge.status({ projectId });
      assert.equal(status.mode, "empty");
      assert.isNull(yield* knowledge.view(projectId));
      const { stateDir } = yield* ServerConfig.ServerConfig;
      assert.isFalse(NodeFS.existsSync(indexFile(stateDir, projectId)));
    }),
  );

  it.effect("rebuilds from scratch and removes the index of a deleted project", () =>
    Effect.gen(function* () {
      const root = workspace({ ".specweave/docs/a.md": "# Alpha\n\nrebuild me\n" });
      const projectId = yield* seed("knowledge-lifecycle", root);
      const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      assert.equal((yield* knowledge.status({ projectId })).documents, 1);
      assert.isTrue(NodeFS.existsSync(indexFile(stateDir, projectId)));

      assert.equal((yield* knowledge.reindex({ projectId })).state, "indexing");
      yield* knowledge.drain;
      const rebuilt = yield* knowledge.status({ projectId });
      assert.equal(rebuilt.state, "ready");
      assert.equal(rebuilt.documents, 1);

      yield* (yield* ProjectStore.ProjectStoreV2).apply({
        ...projectEvent(projectId, 2),
        type: "project.deleted",
        payload: { projectId, deletedAt: "2026-10-20T00:00:01.000Z" },
      });
      yield* changed(projectId);
      assert.isFalse(NodeFS.existsSync(indexFile(stateDir, projectId)));
      const gone = yield* knowledge.status({ projectId }).pipe(Effect.flip);
      assert.equal(gone.code, "not_found");
    }),
  );
});

it.effect("removes the least recently used index past the disk budget and rebuilds it on use", () =>
  Effect.gen(function* () {
    const first = yield* seed("evict-first", workspace({ ".specweave/docs/a.md": "aardvark" }));
    const second = yield* seed("evict-second", workspace({ ".specweave/docs/b.md": "badger" }));
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const exists = (projectId: ProjectId) => NodeFS.existsSync(indexFile(stateDir, projectId));
    yield* knowledge.status({ projectId: first });
    assert.isTrue(exists(first), "the project just indexed is never removed");
    yield* knowledge.status({ projectId: second });
    assert.isFalse(exists(first));
    assert.isTrue(exists(second));
    const found = yield* knowledge.search({ projectId: first, query: "aardvark" });
    assert.lengthOf(found.results, 1, "a search waits for the rebuild");
    assert.isTrue(exists(first));
    assert.isFalse(exists(second));
  }).pipe(
    Effect.provide(
      stack("knowledge-evict-", Layer.succeed(ProjectKnowledge.KnowledgeIndexBudgetBytes, 1)),
    ),
  ),
);

it.effect("rebuilds an archived project's index once it was removed for space", () =>
  Effect.gen(function* () {
    const archived = yield* seed(
      "evict-archived",
      workspace({ ".specweave/docs/a.md": "armadillo" }),
    );
    const other = yield* seed("evict-other", workspace({ ".specweave/docs/b.md": "bison" }));
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const sql = yield* SqlClient.SqlClient;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    yield* knowledge.status({ projectId: archived });
    yield* sql`UPDATE projection_projects SET workspace_settings_json=${JSON.stringify({ ...DEFAULT_PROJECT_WORKSPACE_SETTINGS, archived: true })} WHERE project_id=${archived}`;
    yield* knowledge.status({ projectId: other });
    assert.isFalse(NodeFS.existsSync(indexFile(stateDir, archived)));
    assert.equal((yield* knowledge.status({ projectId: archived })).state, "indexing");
    const found = yield* knowledge.search({ projectId: archived, query: "armadillo" });
    assert.lengthOf(found.results, 1);
    assert.equal(found.state, "ready");
  }).pipe(
    Effect.provide(
      stack("knowledge-archived-", Layer.succeed(ProjectKnowledge.KnowledgeIndexBudgetBytes, 1)),
    ),
  ),
);

it.effect("pauses indexing while the disk is almost full and says so", () =>
  Effect.gen(function* () {
    const projectId = yield* seed("disk-full", workspace({ ".specweave/docs/a.md": "anything" }));
    const knowledge = yield* ProjectKnowledge.ProjectKnowledge;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const status = yield* knowledge.status({ projectId });
    assert.equal(status.state, "failed");
    assert.include(status.problem ?? "", "disk is almost full");
    assert.isFalse(NodeFS.existsSync(indexFile(stateDir, projectId)));
  }).pipe(
    Effect.provide(
      stack(
        "knowledge-disk-",
        Layer.mock(DiskSpaceMonitor.DiskSpaceMonitor)({
          current: Effect.succeed(
            Option.some({
              level: "critical" as const,
              freeBytes: 1,
              totalBytes: 2,
              checkedAt: "2026-10-20T00:00:00.000Z",
            }),
          ),
        }),
      ),
    ),
  ),
);
