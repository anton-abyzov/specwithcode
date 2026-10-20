import { expect, it } from "vite-plus/test";

import { expandBraceShorthand } from "./markdown-links";
import { collectThreadArtifacts, settleThreadArtifacts } from "./threadArtifacts";

const CWD = "/Users/me/Projects/github/specweave-studio";

it("lists the files, pages and links a thread names, newest first, once each", () => {
  const artifacts = collectThreadArtifacts(
    [
      {
        id: "m1",
        text: [
          "Draft: `/tmp/promo/victoria_email.html`, cover `/tmp/promo/snap-cover.jpg`.",
          "See [gitops #254](https://github.com/acme/gitops/pull/254).",
        ].join("\n"),
      },
      {
        id: "m2",
        text: [
          "Cut `/tmp/promo/snap-18s-master.mp4` and `/tmp/promo/voice.m4a`.",
          "Fixed `apps/web/src/app.ts:12` and again at `apps/web/src/app.ts:40`.",
          "Worktree: `~/Projects/github/studio-machine-label` and `png/app/`.",
          "Report: `docs/report.md`, deck https://example.com/deck.",
          "```",
          "cp /tmp/promo/example-only.png /tmp/promo/copy.png",
          "```",
        ].join("\n"),
      },
    ],
    CWD,
  );
  expect(artifacts.map((artifact) => [artifact.kind, artifact.name])).toEqual([
    ["link", "deck"],
    ["markdown", "report.md"],
    ["code", "app.ts"],
    ["audio", "voice.m4a"],
    ["video", "snap-18s-master.mp4"],
    ["link", "gitops #254"],
    ["image", "snap-cover.jpg"],
    ["html", "victoria_email.html"],
  ]);
  expect(artifacts[0]).toMatchObject({ url: "https://example.com/deck", host: "example.com" });
  expect(artifacts.find((artifact) => artifact.name === "app.ts")).toMatchObject({
    messageId: "m2",
    // The worktree the message names is the first guess; the host settles it.
    meta: { filePath: "/Users/me/Projects/github/studio-machine-label/apps/web/src/app.ts" },
  });
});

it("lists each file a brace list names, not the pattern", () => {
  const authored = collectThreadArtifacts(
    [
      {
        id: "a1",
        text: "Screenshots: `/tmp/run-identity/run-identity-{1440-dark,1440-light,1000-light}.png`.",
      },
    ],
    "/work",
  );
  expect(authored).toHaveLength(1);
  const artifacts = settleThreadArtifacts(authored, new Map());
  expect(artifacts.map((artifact) => artifact.name).toSorted()).toEqual([
    "run-identity-1000-light.png",
    "run-identity-1440-dark.png",
    "run-identity-1440-light.png",
  ]);
  expect(expandBraceShorthand("a-{x,y}-{1,2}.png")).toEqual([
    "a-x-1.png",
    "a-x-2.png",
    "a-y-1.png",
    "a-y-2.png",
  ]);
});

it("lists a fenced path list and files written outside the workspace", () => {
  const cws = "/Users/me/Downloads/cws";
  const artifacts = collectThreadArtifacts(
    [
      { id: "m1", text: `Assets are in \`${cws}/\`.` },
      { id: "m2", text: "Screenshots:\n```\nscreenshot-1.png\nscreenshot-2.png\n```\n" },
    ],
    CWD,
    [
      { path: `${cws}/SUBMISSION.md`, itemId: "write-1" },
      { path: `${CWD}/src/app.ts`, itemId: "write-2" },
    ],
  );
  const names = artifacts.map((artifact) => artifact.name);
  expect(names).toEqual(["screenshot-2.png", "screenshot-1.png", "SUBMISSION.md"]);
  const first = artifacts[0]!;
  expect("meta" in first && first.meta.filePath).toBe(`${cws}/screenshot-2.png`);
});
