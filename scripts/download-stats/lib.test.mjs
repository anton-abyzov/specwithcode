// Runs under `node --test` and under the repository's Vitest run alike: both runners
// provide describe/it, so the file picks whichever one is loading it.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  buildDailyCsv,
  buildLatestSummary,
  buildSnapshot,
  classifyAsset,
  deltaByPlatform,
  fetchAllReleases,
  nextPageUrl,
  sortSnapshotNames,
  totalsByPlatform,
} from "./lib.mjs";
import { parseArgs as parseSnapshotArgs, writeSnapshot } from "./snapshot.mjs";
import { parseArgs as parseTodayArgs } from "./today.mjs";

const { describe, it } = process.env.VITEST
  ? await import("vite-plus/test")
  : await import("node:test");

const snap = (releases) => ({ takenAt: "t", repo: "o/r", releases });
const rel = (tag, assets) => ({
  tag,
  publishedAt: null,
  assets: Object.entries(assets).map(([name, downloadCount]) => ({ name, downloadCount })),
});

describe("classifyAsset", () => {
  const cases = {
    "SpecWithCode-1.0.223-arm64.dmg": "mac-dmg",
    "SpecWithCode-arm64.dmg": "mac-dmg",
    "SpecWithCode-1.0.223-arm64.zip": "mac-zip",
    "SpecWithCode-1.0.223-mac.zip": "mac-zip",
    "SpecWithCode-1.0.223-x64.exe": "windows-exe",
    "SpecWithCode-1.0.223-arm64.exe": "windows-exe",
    "SpecWithCode-1.0.223-amd64.deb": "linux-deb",
    "SpecWithCode-1.0.223-x86_64.AppImage": "linux-appimage",
    "install.sh": "install-script",
    "install.ps1": "install-script",
    "studio-1.0.223-linux-x64-ff70fcb7c9ed.tar.gz": "server-archive",
    "studio-1.0.223-win32-x64.zip": "server-archive",
    "studio-1.0.223-win32-arm64.zip": "server-archive",
    "latest.yml": "update-metadata",
    "latest-mac.yml": "update-metadata",
    "latest-linux-arm64.yml": "update-metadata",
    "studio-update.json": "update-metadata",
    "SpecWithCode-1.0.223-arm64.dmg.blockmap": "update-metadata",
    "SpecWithCode-1.0.223-x64.exe.blockmap": "update-metadata",
    SHA256SUMS: "update-metadata",
    "SHA256SUMS-windows-linux": "update-metadata",
    "deployment-helpers-manifest.json": "update-metadata",
    "SHA256SUMS-windows-linux.asc": "signature",
    "SpecWithCode-1.0.223-amd64.deb.asc": "signature",
    "specwithcode-release-key.asc": "signature",
    "notes.txt": "other",
  };
  for (const [name, platform] of Object.entries(cases)) {
    it(`${name} -> ${platform}`, () => NodeAssert.equal(classifyAsset(name), platform));
  }
});

describe("totals and delta", () => {
  const prev = snap([rel("v1", { "a.dmg": 10, "a-arm64.zip": 5, "install.sh": 2 })]);
  const cur = snap([
    rel("v2", { "b.dmg": 3, "latest-mac.yml": 7 }),
    rel("v1", { "a.dmg": 14, "a-arm64.zip": 4, "install.sh": 2, "x.exe": 1 }),
  ]);

  it("sums cumulative totals with new-installs, updates and all", () => {
    const t = totalsByPlatform(cur);
    NodeAssert.equal(t["mac-dmg"], 17);
    NodeAssert.equal(t["mac-zip"], 4);
    NodeAssert.equal(t["windows-exe"], 1);
    NodeAssert.equal(t["update-metadata"], 7);
    NodeAssert.equal(t["new-installs"], 17 + 2 + 1);
    NodeAssert.equal(t.updates, 4 + 7);
    NodeAssert.equal(t.all, 31);
  });

  it("counts per-asset growth, new assets fully, and never a negative change", () => {
    const d = deltaByPlatform(cur, prev);
    NodeAssert.equal(d["mac-dmg"], 4 + 3);
    NodeAssert.equal(d["mac-zip"], 0);
    NodeAssert.equal(d["install-script"], 0);
    NodeAssert.equal(d["windows-exe"], 1);
    NodeAssert.equal(d["update-metadata"], 7);
    NodeAssert.equal(d["new-installs"], 8);
    NodeAssert.equal(d.updates, 7);
    NodeAssert.equal(d.all, 15);
  });

  it("matches assets by tag and name, so the same name in a new release is new", () => {
    const a = snap([rel("v1", { "install.sh": 5 })]);
    const b = snap([rel("v1", { "install.sh": 5 }), rel("v2", { "install.sh": 2 })]);
    NodeAssert.equal(deltaByPlatform(b, a)["install-script"], 2);
  });

  it("treats a missing previous snapshot as zero", () => {
    NodeAssert.equal(deltaByPlatform(cur, null).all, totalsByPlatform(cur).all);
  });
});

describe("buildSnapshot", () => {
  it("drops drafts, keeps the payload shape and sorts newest first", () => {
    const s = buildSnapshot(
      [
        {
          tag_name: "v1",
          published_at: "2026-01-01T00:00:00Z",
          assets: [
            { name: "z", download_count: 1 },
            { name: "a", download_count: 2 },
          ],
        },
        { tag_name: "v2", published_at: "2026-02-01T00:00:00Z", assets: [] },
        { tag_name: "draft", draft: true, published_at: null, assets: [] },
      ],
      { repo: "o/r", takenAt: "2026-02-02T00:00:00Z" },
    );
    NodeAssert.deepEqual(s, {
      takenAt: "2026-02-02T00:00:00Z",
      repo: "o/r",
      releases: [
        { tag: "v2", publishedAt: "2026-02-01T00:00:00Z", assets: [] },
        {
          tag: "v1",
          publishedAt: "2026-01-01T00:00:00Z",
          assets: [
            { name: "a", downloadCount: 2 },
            { name: "z", downloadCount: 1 },
          ],
        },
      ],
    });
  });
});

describe("csv and summary", () => {
  it("writes one row per platform per date with an empty first delta", () => {
    const csv = buildDailyCsv([
      { date: "2026-11-02", snapshot: snap([rel("v1", { "a.dmg": 3 })]) },
      { date: "2026-11-01", snapshot: snap([rel("v1", { "a.dmg": 1 })]) },
    ])
      .trim()
      .split("\n");
    NodeAssert.equal(csv[0], "date,platform,total,delta");
    NodeAssert.ok(csv.includes("2026-11-01,mac-dmg,1,"));
    NodeAssert.ok(csv.includes("2026-11-02,mac-dmg,3,2"));
    NodeAssert.ok(csv.includes("2026-11-02,all,3,2"));
    NodeAssert.ok(csv.indexOf("2026-11-01,mac-dmg,1,") < csv.indexOf("2026-11-02,mac-dmg,3,2"));
  });

  it("summarises the newest snapshot", () => {
    const s = buildLatestSummary({
      date: "2026-11-02",
      snapshot: snap([rel("v2", { "a.exe": 4 })]),
      previousDate: "2026-11-01",
      previous: snap([rel("v2", { "a.exe": 1 })]),
    });
    NodeAssert.equal(s.latestTag, "v2");
    NodeAssert.equal(s.totals["windows-exe"], 4);
    NodeAssert.equal(s.delta["windows-exe"], 3);
  });

  it("sorts snapshot names and ignores other files", () => {
    NodeAssert.deepEqual(
      sortSnapshotNames(["snapshots/2026-11-02.json", "README.md", "2026-11-01.json", "x.json"]),
      ["2026-11-01.json", "2026-11-02.json"],
    );
  });
});

describe("writeSnapshot", () => {
  it("overwrites the same day and regenerates daily.csv and latest.json", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "download-stats-"));
    try {
      writeSnapshot(dir, "2026-11-01", snap([rel("v1", { "a.dmg": 1 })]));
      writeSnapshot(dir, "2026-11-02", snap([rel("v1", { "a.dmg": 2 })]));
      const again = writeSnapshot(dir, "2026-11-02", snap([rel("v1", { "a.dmg": 5 })]));
      NodeAssert.deepEqual(NodeFS.readdirSync(NodePath.join(dir, "snapshots")).sort(), [
        "2026-11-01.json",
        "2026-11-02.json",
      ]);
      NodeAssert.equal(again.delta["mac-dmg"], 4);
      const latest = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "latest.json"), "utf8"));
      NodeAssert.equal(latest.date, "2026-11-02");
      NodeAssert.equal(latest.previousDate, "2026-11-01");
      const csv = NodeFS.readFileSync(NodePath.join(dir, "daily.csv"), "utf8");
      NodeAssert.ok(csv.includes("2026-11-02,mac-dmg,5,4"));
      NodeAssert.equal(csv.match(/^2026-11-02,mac-dmg,/gm).length, 1);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pagination", () => {
  it("parses the next link", () => {
    NodeAssert.equal(
      nextPageUrl(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=5>; rel="last"',
      ),
      "https://api.github.com/x?page=2",
    );
    NodeAssert.equal(nextPageUrl('<https://api.github.com/x?page=1>; rel="prev"'), null);
    NodeAssert.equal(nextPageUrl(null), null);
  });

  it("follows every page with a stubbed fetch", async () => {
    const calls = [];
    const pages = {
      "https://api.github.com/repos/o/r/releases?per_page=100": [
        [{ tag_name: "v2" }],
        '<https://p2>; rel="next"',
      ],
      "https://p2": [[{ tag_name: "v1" }], null],
    };
    const fetchImpl = async (url, init) => {
      calls.push([url, init.headers.authorization]);
      const [body, link] = pages[url];
      return { ok: true, json: async () => body, headers: { get: () => link } };
    };
    const all = await fetchAllReleases("o/r", { token: "tok", fetchImpl });
    NodeAssert.deepEqual(
      all.map((r) => r.tag_name),
      ["v2", "v1"],
    );
    NodeAssert.deepEqual(
      calls.map((c) => c[1]),
      ["Bearer tok", "Bearer tok"],
    );
  });

  it("fails on an error status", async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, statusText: "Forbidden" });
    await NodeAssert.rejects(fetchAllReleases("o/r", { fetchImpl }), /403/);
  });
});

describe("arguments", () => {
  it("snapshot requires --out unless it is a dry run", () => {
    NodeAssert.throws(() => parseSnapshotArgs([]), /--out/);
    NodeAssert.equal(parseSnapshotArgs(["--dry-run"]).dryRun, true);
    NodeAssert.equal(parseSnapshotArgs(["--out", "d"]).out, "d");
    NodeAssert.throws(() => parseSnapshotArgs(["--out", "d", "--date", "11/01"]), /YYYY-MM-DD/);
    NodeAssert.throws(() => parseSnapshotArgs(["--out", "d", "--repo", "bad"]), /owner\/name/);
  });

  it("today defaults to the remote data branch", () => {
    NodeAssert.equal(parseTodayArgs([]).ref, "origin/download-stats");
    NodeAssert.equal(parseTodayArgs(["--remote", "up"]).ref, "up/download-stats");
    NodeAssert.equal(parseTodayArgs(["--live", "--json"]).live, true);
    NodeAssert.equal(parseTodayArgs(["--no-fetch"]).fetch, false);
  });
});
