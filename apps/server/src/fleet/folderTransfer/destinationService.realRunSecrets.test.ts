// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - disposable real Git fixtures only.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { DestinationCopies } from "./destinationService.ts";
import { git, makeUmbrella, write, type UmbrellaFixture } from "./folderFixture.testkit.ts";
import { SourceTransfers } from "./sourceService.ts";
import { serveSource } from "./sourceTestServer.testkit.ts";

// The secret files a real copy detected and left behind: an umbrella repository with nested
// repositories two folders down. With the default choice every one of them must arrive.
const REAL_RUN = [
  ".env",
  ".env.bak-20260715",
  ".env.cloudflare",
  "repositories/anton-abyzov/specwithcode/.env",
  "repositories/anton-abyzov/vskill-platform/.dev.vars",
  "repositories/anton-abyzov/vskill-platform/.env",
  "repositories/anton-abyzov/vskill-platform/.env.local",
  "repositories/anton-abyzov/vskill-platform/crawl-worker/.env",
  "repositories/anton-abyzov/vskill-platform/scanner-worker/.env",
  "scripts/.cf-monitor.env",
];
const content = (path: string) => `FIXTURE_ONLY=${path}\n`;

let base: string;
let fixture: UmbrellaFixture;
let transfers: SourceTransfers;
let served: Awaited<ReturnType<typeof serveSource>>;
let destinationHome: string;

function nestedRepository(root: string, path: string) {
  const directory = NodePath.join(root, path);
  NodeFS.mkdirSync(directory, { recursive: true });
  git(directory, "init", "-q");
  write(NodePath.join(directory, "README.md"), `${path}\n`);
  // Some of the files are ignored there and some are only untracked, as in the real folder.
  write(NodePath.join(directory, ".gitignore"), ".env\n.dev.vars\n");
  git(directory, "add", "-A");
  git(directory, "commit", "-q", "-m", "initial");
}

beforeAll(async () => {
  base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "swc-real-run-")));
  fixture = makeUmbrella(base);
  nestedRepository(fixture.root, "repositories/anton-abyzov/specwithcode");
  nestedRepository(fixture.root, "repositories/anton-abyzov/vskill-platform");
  for (const path of REAL_RUN) write(NodePath.join(fixture.root, path), content(path));
  const sourceHome = NodePath.join(base, "source-home");
  destinationHome = NodePath.join(base, "destination-home");
  NodeFS.mkdirSync(sourceHome, { recursive: true });
  NodeFS.mkdirSync(destinationHome, { recursive: true });
  transfers = new SourceTransfers(NodePath.join(base, "source-state"), {
    release: async () => undefined,
    home: () => sourceHome,
  });
  served = await serveSource(transfers, "env-source");
}, 60_000);
afterAll(async () => {
  if (served !== undefined) await served.close();
  NodeFS.rmSync(base, { recursive: true, force: true });
});

const fast = { allowLoopback: true, sleep: async () => undefined, pollMs: 20 } as const;

async function settle(
  copies: DestinationCopies,
  operationId: string,
  until: ReadonlyArray<string>,
) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await copies.waitFor(operationId);
    const record = await copies.read(operationId);
    if (record && until.includes(record.state)) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`copy ${operationId} never reached ${until.join(", ")}`);
}

/** Offers the folder and brings a destination to its review, as the dialog does. */
async function previewed(name: string) {
  const operationId = NodeCrypto.randomUUID();
  const { token } = await transfers.offer({
    operationId,
    projectId: "project-source",
    folder: fixture.root,
    mode: "copy-only",
    destinationEnvironmentId: "env-destination",
  });
  const copies = new DestinationCopies(NodePath.join(base, `dest-state-${name}`), {
    ...fast,
    home: () => destinationHome,
  });
  const target = NodePath.join(base, "targets", name);
  await copies.start({
    operationId,
    sourceUrl: served.url,
    token,
    sourceEnvironmentId: "env-source",
    sourceProjectId: "project-source",
    sourceMachine: "M4MAX",
    mode: "copy-only",
    targetFolder: target,
    title: "Umbrella",
  });
  await settle(copies, operationId, ["previewed"]);
  return { operationId, copies, target };
}

const stage = (operationId: string, paths: ReadonlyArray<string>) =>
  transfers.approveSecrets({ operationId, paths, destinationLabel: "M5" });

const arrived = (target: string) =>
  REAL_RUN.filter((path) => NodeFS.existsSync(NodePath.join(target, path)));

describe("the secret files of a real copy", () => {
  it("carries every detected secret file with the default choice", async () => {
    const { operationId, copies, target } = await previewed("all");
    // What the dialog shows and sends by default: the source's whole list.
    const detected = (await transfers.read(operationId))?.summary?.secretFiles ?? [];
    expect(detected.map((file) => file.path)).toEqual(REAL_RUN);
    const staged = await stage(
      operationId,
      detected.map((file) => file.path),
    );
    expect(staged.secrets?.files.map((file) => file.path)).toEqual(REAL_RUN);
    await copies.approve(operationId, { expectedSecrets: REAL_RUN });
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.state).toBe("applied");
    expect(applied.committed).toBe(true);
    expect(applied.secrets?.map((file) => [file.path, file.writtenAs, file.state])).toEqual(
      REAL_RUN.map((path) => [path, path, "written"]),
    );
    for (const path of REAL_RUN) {
      expect(NodeFS.readFileSync(NodePath.join(target, path), "utf8")).toBe(content(path));
      if (process.platform !== "win32")
        expect(NodeFS.statSync(NodePath.join(target, path)).mode & 0o777).toBe(0o600);
    }
    const sent = await transfers.sentSecrets.list("env-destination");
    expect(
      sent
        .filter((entry) => entry.operationId === operationId)
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([...REAL_RUN].sort());
    expect((await transfers.read(operationId))?.state).toBe("committed");
    await copies.close();
  }, 180_000);

  it("does not finish as a full copy when the source no longer offers a file the window sent", async () => {
    const { operationId, copies, target } = await previewed("lost");
    await stage(operationId, REAL_RUN);
    // Another window took one file off after this one sent its list and before the approval.
    const kept = REAL_RUN.filter((path) => path !== "scripts/.cf-monitor.env");
    await stage(operationId, kept);
    await copies.approve(operationId, { expectedSecrets: REAL_RUN });
    const failed = await settle(copies, operationId, ["applied", "failed"]);
    expect(failed.state).toBe("failed");
    expect(failed.failedStep).toBe("applied");
    expect(failed.committed).toBe(false);
    expect(failed.error?.message).toBe(
      "1 secret file approved for this copy was no longer offered by M4MAX. The other files are in place here. Copy again to send it.",
    );
    // Everything still offered arrived; nothing was reported as complete.
    expect(arrived(target)).toEqual(kept);
    expect((await transfers.read(operationId))?.state).not.toBe("committed");
    // Sent again, Retry finishes with every file.
    await stage(operationId, REAL_RUN);
    await copies.retry(operationId);
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.committed).toBe(true);
    expect(arrived(target)).toEqual(REAL_RUN);
    expect(applied.secrets?.map((file) => file.path).sort()).toEqual([...REAL_RUN].sort());
    await copies.close();
  }, 180_000);

  it("reads a withdrawn list as a failure, not as a copy without secrets", async () => {
    const { operationId, copies, target } = await previewed("withdrawn");
    await stage(operationId, REAL_RUN);
    await stage(operationId, []);
    await copies.approve(operationId, { expectedSecrets: REAL_RUN });
    const failed = await settle(copies, operationId, ["applied", "failed"]);
    expect(failed.state).toBe("failed");
    expect(failed.committed).toBe(false);
    expect(failed.error?.message).toContain("10 secret files approved for this copy were");
    expect(arrived(target)).toEqual([]);
    // A choice to leave secrets on the source still approves cleanly.
    const without = await previewed("without");
    await without.copies.approve(without.operationId, {
      withoutSecrets: true,
      expectedSecrets: REAL_RUN,
    });
    const applied = await settle(without.copies, without.operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.committed).toBe(true);
    expect(arrived(without.target)).toEqual([]);
    await copies.close();
    await without.copies.close();
  }, 180_000);

  it("pulls only the files the approval named, whatever else is staged", async () => {
    const { operationId, copies, target } = await previewed("named");
    // This window sent three; another window then staged the whole list.
    const named = REAL_RUN.slice(0, 3);
    await stage(operationId, named);
    await stage(operationId, REAL_RUN);
    await copies.approve(operationId, { expectedSecrets: named });
    const applied = await settle(copies, operationId, ["applied", "failed"]);
    expect(applied.error).toBeNull();
    expect(applied.committed).toBe(true);
    expect(arrived(target)).toEqual(named);
    expect(applied.secrets?.map((file) => file.path)).toEqual(named);
    // A window that sent none (every file unticked) gets none, although a list is staged.
    const none = await previewed("named-none");
    await stage(none.operationId, REAL_RUN);
    await none.copies.approve(none.operationId, { expectedSecrets: [] });
    const without = await settle(none.copies, none.operationId, ["applied", "failed"]);
    expect(without.error).toBeNull();
    expect(without.committed).toBe(true);
    expect(arrived(none.target)).toEqual([]);
    await copies.close();
    await none.copies.close();
  }, 180_000);
});
