import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type { SkillPublication } from "@specweave-studio/contracts";
import {
  SkillPublishingAdapter,
  SkillPublishingError,
  SkillPublishingService,
  layer,
} from "./SkillPublishingService.ts";
const draft = {
  name: "weekly-notes",
  description: "Write notes",
  instructions: "Summarize notes.",
  version: "1.0.0",
};
const destination = {
  repository: "example/skills",
  visibility: "private" as const,
  tenant: "example",
};
function fixture(overrides: Partial<SkillPublishingAdapter["Service"]> = {}) {
  let saved: SkillPublication | undefined;
  const events: string[] = [];
  const adapter = SkillPublishingAdapter.of({
    prepare: () => Effect.succeed({ tenantId: "t1" }),
    upload: () =>
      Effect.sync(() => {
        events.push("upload");
      }),
    submit: () =>
      Effect.sync(() => {
        events.push("submit");
        return { id: "psub_1", state: "RECEIVED" };
      }),
    status: () => Effect.succeed({ id: "psub_1", state: "TIER1_SCANNING" }),
    verify: () => Effect.void,
    apply: () =>
      Effect.succeed({
        preview: false,
        expectedHash: "hash",
        files: [],
        summary: "Installed",
        ready: false,
      }),
    ...overrides,
  });
  const persist = (value: SkillPublication) =>
    Effect.sync(() => {
      events.push(`save:${value.state}`);
      saved = value;
    });
  const run = <A>(
    f: (s: SkillPublishingService["Service"]) => Effect.Effect<A, SkillPublishingError>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* f(yield* SkillPublishingService);
      }).pipe(
        Effect.provide(layer.pipe(Layer.provide(Layer.succeed(SkillPublishingAdapter, adapter)))),
      ),
    );
  return { run, persist, events, saved: () => saved };
}
describe("skill publication", () => {
  it("persists intent before POST and resumes without another POST", async () => {
    const f = fixture();
    const publication = await f.run((s) => s.publish({ draft, destination, persist: f.persist }));
    expect(f.events.indexOf("save:submitting")).toBeLessThan(f.events.indexOf("submit"));
    await f.run((s) =>
      s.publish({ draft: { ...draft, publication }, destination, persist: f.persist }),
    );
    expect(f.events.filter((e) => e === "submit")).toHaveLength(1);
  });
  it("refuses unavailable private account before uploading", async () => {
    const f = fixture({
      prepare: () => Effect.fail(new SkillPublishingError({ detail: "private unavailable" })),
    });
    await expect(
      f.run((s) => s.publish({ draft, destination, persist: f.persist })),
    ).rejects.toThrow("private unavailable");
    expect(f.events).toEqual([]);
  });
  it("keeps lost responses durable and recovers by status", async () => {
    const f = fixture({
      submit: () => Effect.fail(new SkillPublishingError({ detail: "network" })),
    });
    const publication = await f.run((s) => s.publish({ draft, destination, persist: f.persist }));
    expect(f.saved()?.state).toBe("unknown");
    const recovered = await f.run((s) =>
      s.status({ draft: { ...draft, publication }, persist: f.persist }),
    );
    expect(recovered.submissionId).toBe("psub_1");
    expect(recovered.state).toBe("reviewing");
  });
  it("keeps rejection, blocked, approval and publication distinct", async () => {
    for (const [remote, state] of [
      ["REJECTED", "rejected"],
      ["BLOCKED", "blocked"],
      ["AUTO_APPROVED", "reviewing"],
      ["PUBLISHED", "published"],
    ]) {
      const f = fixture({ status: () => Effect.succeed({ id: "psub_1", state: remote! }) });
      expect(
        (await f.run((s) => s.publish({ draft, destination, persist: f.persist }))).state,
      ).toBe(state);
    }
  });
  it("requires exact published content before application", async () => {
    const f = fixture({
      status: () => Effect.succeed({ id: "psub_1", state: "PUBLISHED" }),
      verify: () => Effect.fail(new SkillPublishingError({ detail: "wrong hash" })),
    });
    const publication = await f.run((s) => s.publish({ draft, destination, persist: f.persist }));
    expect(publication.state).toBe("reviewing");
    await expect(
      f.run((s) =>
        s.apply({
          draft: { ...draft, publication },
          cwd: "/scratch",
          request: { scope: "project", agents: ["codex"], instanceIds: [] },
          preview: true,
          refresh: () => Effect.void,
        }),
      ),
    ).rejects.toThrow("verified published");
  });
  it("refuses edits to an in-flight publication", async () => {
    const f = fixture();
    const publication = await f.run((s) => s.publish({ draft, destination, persist: f.persist }));
    await expect(
      f.run((s) =>
        s.status({ draft: { ...draft, instructions: "changed", publication }, persist: f.persist }),
      ),
    ).rejects.toThrow("differs");
  });
  it("persists the submit receipt even when the caller interrupts after intent is saved", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const f = fixture({
      submit: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ id: "psub_1", state: "RECEIVED" }),
        ),
    });
    await f.run((s) =>
      Effect.gen(function* () {
        const publishing = yield* s
          .publish({ draft, destination, persist: f.persist })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        expect(f.saved()?.state).toBe("submitting");
        const interrupting = yield* Fiber.interrupt(publishing).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interrupting);
        expect(f.saved()?.submissionId).toBe("psub_1");
        expect(f.saved()?.state).toBe("reviewing");
      }),
    );
  });
  it("makes a conclusively absent public submission recoverable without resubmitting", async () => {
    const f = fixture({
      submit: () => Effect.fail(new SkillPublishingError({ detail: "lost response" })),
      status: () =>
        Effect.succeed({
          id: "",
          state: "UNSUBMITTED",
          detail: "Archive this draft to create a new version.",
        }),
    });
    const publication = await f.run((s) => s.publish({ draft, destination, persist: f.persist }));
    const recovered = await f.run((s) =>
      s.status({ draft: { ...draft, publication }, persist: f.persist }),
    );
    expect(recovered.state).toBe("blocked");
    expect(recovered.submissionId).toBeUndefined();
    expect(recovered.detail).toContain("Archive");
  });
});
