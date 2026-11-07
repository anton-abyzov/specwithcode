import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  openWorktreeSetPullRequests,
  replaceWorktreeSetPullRequestNote,
  worktreeSetPullRequestNote,
} from "./worktreeSetPullRequests.ts";

const ready = [
  { label: "project", cwd: "/set" },
  { label: "repositories/acme/api", cwd: "/set/repositories/acme/api" },
  { label: "web", cwd: "/set/web" },
];

describe("worktree set pull requests", () => {
  it("names the branch, the increment and every repository", () => {
    const note = worktreeSetPullRequestNote({
      branch: "feat/login",
      incrementId: "1251-per-increment-multi-repo-worktrees",
      entries: [
        { label: "project", url: "https://github.com/acme/project/pull/1" },
        { label: "web" },
      ],
    });
    expect(note).toContain("branch `feat/login`");
    expect(note).toContain("increment `1251-per-increment-multi-repo-worktrees`");
    expect(note).toContain("- `project`: https://github.com/acme/project/pull/1");
    expect(note).toContain("- `web`: its pull request from the same branch");
  });

  it("replaces its own note and keeps the rest of the description", () => {
    const first = worktreeSetPullRequestNote({
      branch: "b",
      incrementId: null,
      entries: [{ label: "a" }],
    });
    const body = replaceWorktreeSetPullRequestNote("Summary\n\nDetails\n", first);
    expect(body.startsWith("Summary\n\nDetails\n\n<!-- specwithcode:worktree-set -->")).toBe(true);
    const second = worktreeSetPullRequestNote({
      branch: "b",
      incrementId: null,
      entries: [{ label: "a", url: "https://example.invalid/1" }],
    });
    const rewritten = replaceWorktreeSetPullRequestNote(`${body}\nFooter`, second);
    expect(rewritten).toContain("https://example.invalid/1");
    expect(rewritten).not.toContain("from the same branch");
    expect(rewritten.startsWith("Summary\n\nDetails")).toBe(true);
    expect(rewritten.endsWith("\nFooter")).toBe(true);
  });

  it.effect("opens one per repository, then links every one to all the others", () =>
    Effect.gen(function* () {
      const notes: Array<string | undefined> = [];
      const bodies = new Map<number, string>();
      let next = 1;
      const result = yield* openWorktreeSetPullRequests({
        branch: "feat/x",
        incrementId: "0007-x",
        ready,
        open: (entry, note) =>
          entry.label === "repositories/acme/api"
            ? Effect.fail("api: Current branch has not been pushed.")
            : Effect.sync(() => {
                notes.push(note);
                const number = next++;
                bodies.set(number, `Generated\n\n${note}`);
                return {
                  number,
                  url: `https://github.com/acme/${entry.label}/pull/${number}`,
                  created: true,
                };
              }),
        edit: (pr, rewrite) =>
          Effect.sync(() => void bodies.set(pr.number, rewrite(bodies.get(pr.number)!))),
      });
      expect(result.opened.map((pr) => pr.label)).toEqual(["project", "web"]);
      expect(result.problems).toEqual(["api: Current branch has not been pushed."]);
      // The second one already links the first.
      expect(notes[1]).toContain("https://github.com/acme/project/pull/1");
      for (const body of bodies.values()) {
        expect(body).toContain("https://github.com/acme/project/pull/1");
        expect(body).toContain("https://github.com/acme/web/pull/2");
        expect(body).toContain("increment `0007-x`");
        expect(body.match(/<!-- specwithcode:worktree-set -->/g)).toHaveLength(1);
      }
    }),
  );

  it.effect("gives a single repository with commits no note", () =>
    Effect.gen(function* () {
      const edits: Array<number> = [];
      const result = yield* openWorktreeSetPullRequests({
        branch: "feat/x",
        incrementId: null,
        ready: ready.slice(0, 1),
        open: (_, note) =>
          Effect.succeed(note === undefined ? { number: 9, url: "u", created: true } : null),
        edit: (pr) => Effect.sync(() => void edits.push(pr.number)),
      });
      expect(result.opened).toHaveLength(1);
      expect(edits).toEqual([]);
    }),
  );

  it.effect("reports a host that cannot rewrite descriptions without failing", () =>
    Effect.gen(function* () {
      const result = yield* openWorktreeSetPullRequests({
        branch: "feat/x",
        incrementId: null,
        ready: ready.slice(0, 2),
        open: (entry) =>
          Effect.succeed({ number: entry.cwd.length, url: entry.cwd, created: true }),
        edit: () => Effect.fail("not allowed"),
      });
      expect(result.opened).toHaveLength(2);
      expect(result.problems).toEqual([
        "project links: not allowed",
        "repositories/acme/api links: not allowed",
      ]);
    }),
  );
});
